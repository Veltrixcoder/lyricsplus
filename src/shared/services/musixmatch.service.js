import crypto from "crypto";
import { v4 as uuidv4 } from 'uuid';
import { DbHandler } from "../utils/db.util.js";
import { SimilarityUtils } from "../utils/similarity.util.js";
import { FileUtils } from "../utils/file.util.js";
import { convertMusixmatchToJSON } from "../parsers/musixmatch.parser.js";
import { musixmatchAccountManager } from "../config.js";

const WEB_BASE_URL = 'https://apic-desktop.musixmatch.com/ws/1.1';
const ANDROID_BASE_URL = 'https://apic.musixmatch.com/ws/1.1/';
const WEB_TOKEN_KEY = 'musixmatch_web_token';
const ANDROID_TOKEN_KEY = 'musixmatch_android_token';
const ANDROID_APP_ID = 'android-player-v1.0';
const ANDROID_USER_AGENT = 'Dalvik/2.1.0 (Linux; U; Android 16; Pixel 8 Pro Build/BP31.250502.008)';
const SIGNING_KEY = "IEJ5E8XFaHQvIQNfs7IC";
const TOKEN_EXPIRY_SECONDS = 600;

// Android implementation are by paxsenix, thank you
// Device spoofed as Google Pixel 8 Pro, A16 QPR2 Beta

// Android client state management
const androidClientStates = new Map();

export class MusixmatchService {

    // --- Public API ---

    static async fetchLyrics(originalSongTitle, originalSongArtist, originalSongAlbum, originalSongDuration, songISRC, songPlatformId, gd, forceReload, env, requireWordSync = false) {
        const initialCache = await this._checkCache(originalSongTitle, originalSongArtist, originalSongAlbum, originalSongDuration, songISRC, songPlatformId, gd, forceReload, requireWordSync);
        if (initialCache) {
            console.debug('Musixmatch lyrics found in cache (initial check).');
            return initialCache;
        }

        const currentAccount = musixmatchAccountManager.getCurrentAccount();
        if (!currentAccount) {
            throw new Error('No Musixmatch account configured.');
        }

        try {
            return await this._fetchLyricsWithAccount(currentAccount, originalSongTitle, originalSongArtist, originalSongAlbum, originalSongDuration, songISRC, songPlatformId, gd, forceReload, env, requireWordSync);
        } catch (error) {
            console.warn(`Fetch failed with ${currentAccount.AUTH_TYPE} API:`, error.message);

            const switched = musixmatchAccountManager.switchToNextAccount();
            if (switched) {
                console.log('Trying next account...');
                const nextAccount = musixmatchAccountManager.getCurrentAccount();
                try {
                    return await this._fetchLyricsWithAccount(nextAccount, originalSongTitle, originalSongArtist, originalSongAlbum, originalSongDuration, songISRC, songPlatformId, gd, forceReload, env, requireWordSync);
                } catch (retryError) {
                    console.warn(`Fetch failed with ${nextAccount.AUTH_TYPE} API:`, retryError.message);
                }
            }

            return null;
        }
    }

    static async _fetchLyricsWithAccount(account, originalSongTitle, originalSongArtist, originalSongAlbum, originalSongDuration, songISRC, songPlatformId, gd, forceReload, env, requireWordSync) {

        // Prioritize ISRC search when available
        let matchedTrack = null;
        if (songISRC) {
            console.debug(`Searching Musixmatch by ISRC: ${songISRC}`);
            try {
                const isrcResult = await this.advancedTrackSearch({ q_track_isrc: songISRC }, account, env);
                const track = isrcResult?.message?.body?.track;
                if (track && track.track_id) {
                    console.debug(`Musixmatch ISRC search found track: ${track.artist_name} - ${track.track_name}`);
                    matchedTrack = track;
                }
            } catch (error) {
                console.warn('Musixmatch ISRC search failed:', error);
            }
        }

        // Fall back to title/artist search if ISRC didn't find anything
        if (!matchedTrack) {
            const isIdOnlySearch = (!originalSongTitle || !originalSongArtist) && (songISRC || songPlatformId);
            if (isIdOnlySearch) {
                console.debug('ISRC search found no match and no title/artist provided. Aborting Musixmatch search.');
                return null;
            }
            matchedTrack = await this._searchForBestMatch(originalSongTitle, originalSongArtist, originalSongAlbum, originalSongDuration, songISRC, account, env);
        }
        if (!matchedTrack) {
            console.warn('No suitable track match found in Musixmatch.');
            return null;
        }

        const { track_name, artist_name, album_name, track_length, track_isrc, track_id } = matchedTrack;
        const exactMetadata = { title: track_name, artist: artist_name, album: album_name, durationMs: track_length * 1000, isrc: track_isrc, platformId: track_id };
        console.debug(`Selected match: ${artist_name} - ${track_name} (Album: ${album_name}, Duration: ${track_length}s, ISRC: ${track_isrc}, MusixmatchId: ${track_id})`);

        const postSearchCache = await this._checkCache(track_name, artist_name, album_name, track_length, track_isrc, track_id, gd, forceReload, requireWordSync);
        if (postSearchCache) {
            console.debug('Musixmatch lyrics found in cache (post-search check).');
            return postSearchCache;
        }

        const lyricsResult = await this._fetchLyricsFromApi(matchedTrack.track_id, account, env, requireWordSync);
        if (!lyricsResult) return null;

        const musixmatchData = { track: matchedTrack, ...lyricsResult };
        const convertedLyrics = convertMusixmatchToJSON(musixmatchData, requireWordSync);
        if (!convertedLyrics) {
            console.warn('Failed to convert Musixmatch data to standard format.');
            return null;
        }

        if (requireWordSync && convertedLyrics.type !== "Word") {
            console.warn('Richsync was required but not available for this track.');
            return null;
        }

        convertedLyrics.cached = 'None';
        return { success: true, data: convertedLyrics, source: 'Musixmatch', rawData: musixmatchData, exactMetadata };
    }

    static async searchTrack(query, account, env) {
        if (!account) account = musixmatchAccountManager.getCurrentAccount();
        if (account.AUTH_TYPE === 'android') {
            return await this._androidSearchTrack(query, account, env);
        } else {
            const userToken = await this.getUserToken(env);
            const url = new URL(`${WEB_BASE_URL}/track.search`);
            url.searchParams.set('page_size', '5');
            url.searchParams.set('f_has_lyrics', 'true');
            url.searchParams.set('page', '1');
            url.searchParams.set('q', query);
            return this._makeWebRequest(url, userToken, account);
        }
    }

    static async normalizeMusixmatchSong(track, account, env) {
        if (!account) account = musixmatchAccountManager.getCurrentAccount();
        let fullTrackDetails = track;
        let songwriters = [];
        let isrc = null;

        try {
            const advancedResult = await this.advancedTrackSearch({ q_track: track.track_name, q_artist: track.artist_name, q_album: track.album_name }, account, env);
            const advancedTrack = advancedResult?.message?.body?.track;
            if (advancedTrack) {
                fullTrackDetails = advancedTrack;
                isrc = advancedTrack.track_isrc || null;
                const writerList = advancedTrack.writer_list || advancedTrack.credits?.writer_list || [];
                songwriters = writerList.map(writer => writer.writer_name);
            }
        } catch (error) {
            console.warn(`Failed to fetch advanced details for ${track.track_name}:`, error);
        }

        const art = fullTrackDetails.album_coverart_100x100 || fullTrackDetails.album_coverart_350x350 || fullTrackDetails.album_coverart_500x500 || null;
        return {
            id: { musixmatch: fullTrackDetails.track_id },
            sourceId: fullTrackDetails.track_id,
            title: fullTrackDetails.track_name,
            artist: fullTrackDetails.artist_name,
            album: fullTrackDetails.album_name,
            albumArtUrl: art,
            durationMs: fullTrackDetails.track_length * 1000,
            isrc: isrc,
            songwriters: songwriters,
            availability: ['Musixmatch'],
            externalUrls: { musixmatch: `https://www.musixmatch.com/lyrics/${encodeURIComponent(fullTrackDetails.artist_name)}/${encodeURIComponent(fullTrackDetails.track_name)}` }
        };
    }

    // --- Core API Endpoints ---

    static async getLyrics(trackId, account, env) {
        if (!account) account = musixmatchAccountManager.getCurrentAccount();
        if (account.AUTH_TYPE === 'android') {
            return this.getSubtitle(trackId, account, env);
        } else {
            const userToken = await this.getUserToken(env);
            const url = new URL(`${WEB_BASE_URL}/track.lyrics.get`);
            url.searchParams.set('track_id', trackId);
            return this._makeWebRequest(url, userToken, account);
        }
    }

    static async getSubtitle(trackId, account, env) {
        if (!account) account = musixmatchAccountManager.getCurrentAccount();
        if (account.AUTH_TYPE === 'android') {
            return await this._androidGetSubtitle(trackId, account, env);
        } else {
            const userToken = await this.getUserToken(env);
            const url = new URL(`${WEB_BASE_URL}/track.subtitle.get`);
            url.searchParams.set('subtitle_format', 'lrc');
            url.searchParams.set('track_id', trackId);
            return this._makeWebRequest(url, userToken, account);
        }
    }

    static async getRichLyrics(trackId, account, env) {
        if (!account) account = musixmatchAccountManager.getCurrentAccount();
        if (account.AUTH_TYPE === 'android') {
            return await this._androidGetRichsync(trackId, account, env);
        } else {
            const userToken = await this.getUserToken(env);
            const url = new URL(`${WEB_BASE_URL}/track.richsync.get`);
            url.searchParams.set('track_id', trackId);
            return this._makeWebRequest(url, userToken, account);
        }
    }

    static async translateLyrics(trackId, account, env, language) {
        if (!account) account = musixmatchAccountManager.getCurrentAccount();
        if (account.AUTH_TYPE === 'android') {
            return await this._androidApiRequest(`${ANDROID_BASE_URL}crowd.track.translations.get`, account, env, {
                translation_fields_set: 'minimal',
                selected_language: language,
                track_id: trackId
            });
        } else {
            const userToken = await this.getUserToken(env);
            const url = new URL(`${WEB_BASE_URL}/crowd.track.translations.get`);
            url.searchParams.set('translation_fields_set', 'minimal');
            url.searchParams.set('selected_language', language);
            url.searchParams.set('track_id', trackId);
            return this._makeWebRequest(url, userToken, account);
        }
    }

    static async advancedTrackSearch(params, account, env) {
        if (!account) account = musixmatchAccountManager.getCurrentAccount();
        if (account.AUTH_TYPE === 'android') {
            const defaultParams = {
                'subtitle_format': 'dfxp',
                'optional_calls': 'track.richsync',
                'part': 'lyrics_crowd,user,lyrics_vote,track_lyrics_translation_status,lyrics_verified_by,labels,track_isrc,writer_list,credits'
            };
            const mergedParams = { ...defaultParams, ...params };
            return await this._androidApiRequest(`${ANDROID_BASE_URL}matcher.track.get`, account, env, mergedParams);
        } else {
            const userToken = await this.getUserToken(env);
            const url = new URL(`${WEB_BASE_URL}/matcher.track.get`);
            const defaultParams = {
                'subtitle_format': 'dfxp',
                'optional_calls': 'track.richsync',
                'part': 'lyrics_crowd,user,lyrics_vote,track_lyrics_translation_status,lyrics_verified_by,labels,track_isrc,writer_list,credits'
            };
            const mergedParams = { ...defaultParams, ...params };
            Object.entries(mergedParams).forEach(([key, value]) => url.searchParams.set(key, value));
            return this._makeWebRequest(url, userToken, account);
        }
    }

    // --- Android API Implementation ---

    static _getApiSignature(apiEndpoint, dateTime) {
        const formattedDate =
            dateTime.getUTCFullYear().toString() +
            String(dateTime.getUTCMonth() + 1).padStart(2, "0") +
            String(dateTime.getUTCDate()).padStart(2, "0");

        const data = apiEndpoint + formattedDate;
        const hmac = crypto.createHmac("sha1", Buffer.from(SIGNING_KEY, "utf8"));
        hmac.update(Buffer.from(data, "utf8"));
        const signature = hmac.digest("base64");

        return signature.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    static _buildAndroidSignedParams(url, params = {}, currentToken = null) {
        const timestamp = new Date();
        const endpoint = url.substring(ANDROID_BASE_URL.length);
        const signature = this._getApiSignature(endpoint, timestamp);

        const finalParams = {
            ...params,
            app_id: ANDROID_APP_ID,
            usertoken: currentToken || '',
            format: 'json',
            signature: signature,
            signature_protocol: 'sha1',
        };

        if (endpoint === 'token.get') {
            finalParams.timestamp = timestamp.toISOString().replace(/\.\d{3}Z$/, 'Z');
            finalParams.guid = uuidv4().replace(/-/g, '');
        }

        return finalParams;
    }

    static async _makeAndroidRequest(url, method = 'GET', params = {}, body = null) {
        const headers = {
            'User-Agent': ANDROID_USER_AGENT,
            'Connection': 'Keep-Alive',
            'Accept-Encoding': 'gzip',
            'x-mxm-endpoint': 'default',
            'Cookie': `x-mxm-token-guid=${uuidv4().replace(/-/g, '')}; mxm-encrypted-token=; x-mxm-user-id=; AWSELB=unknown`
        };

        if (method === 'POST') {
            headers['Content-Type'] = 'application/json';
        }

        const urlObj = new URL(url);
        Object.entries(params).forEach(([key, value]) => {
            urlObj.searchParams.set(key, value);
        });

        const options = {
            method,
            headers,
        };

        if (body) {
            options.body = typeof body === 'string' ? body : JSON.stringify(body);
        }

        const response = await fetch(urlObj.toString(), options);

        const data = await response.json();

        return {
            data: data,
            http_code: response.status,
        };
    }

    static async _clearAndroidToken(env, key) {
        const state = androidClientStates.get(key);
        if (state) {
            state.currentToken = null;
            state.isLoggedIn = false;
        }
        try {
            const kvHandler = new DbHandler(env.LYRICSPLUS);
            await kvHandler.delete(ANDROID_TOKEN_KEY);
        } catch (error) {
            console.warn('Could not delete Android token:', error.message);
        }
    }

    static async _fetchAndroidToken(env) {
        const url = `${ANDROID_BASE_URL}token.get`;
        const params = this._buildAndroidSignedParams(url);
        const response = await this._makeAndroidRequest(url, 'GET', params);

        const data = response.data;

        if (!data?.message?.header?.status_code) {
            throw new Error(`Invalid token response format`);
        }

        const statusCode = data.message.header.status_code;
        if (statusCode !== 200) {
            throw new Error(`Token request failed with status: ${statusCode}`);
        }

        const newToken = data.message.body?.user_token;
        if (!newToken) {
            throw new Error(`No user token found in response`);
        }

        const expirationTime = Date.now() + (TOKEN_EXPIRY_SECONDS * 1000);

        try {
            const kvHandler = new DbHandler(env.LYRICSPLUS);
            await kvHandler.set(ANDROID_TOKEN_KEY, {
                token: newToken,
                expiryTime: expirationTime
            }, TOKEN_EXPIRY_SECONDS);
        } catch (err) {
            console.warn('Failed to cache token:', err.message);
        }

        return { loginNeeded: true, token: newToken };
    }

    static async _getAndroidToken(env, state) {
        if (state.currentToken) {
            state.isLoggedIn = true;
            return { loginNeeded: false, token: state.currentToken };
        }

        try {
            const kvHandler = new DbHandler(env.LYRICSPLUS);
            const cachedTokenData = await kvHandler.get(ANDROID_TOKEN_KEY);
            const currentTime = Date.now();

            if (cachedTokenData?.token && cachedTokenData?.expiryTime > currentTime) {
                state.currentToken = cachedTokenData.token;
                console.log('Using cached Android token.');
                state.isLoggedIn = true;
                return { loginNeeded: false, token: state.currentToken };
            }
        } catch (error) {
            console.warn(`Could not read Android token: ${error.message}`);
        }

        console.log('Fetching a new Android token...');
        return await this._fetchAndroidToken(env);
    }

    static async _androidLogin(account, env, state) {
        const url = `${ANDROID_BASE_URL}credential.post`;
        const postData = {
            "credential_list": [{
                "credential": {
                    "type": "mxm",
                    "action": "login",
                    "email": account.EMAIL,
                    "password": account.PASSWORD
                }
            }]
        };

        const params = this._buildAndroidSignedParams(url, {}, state.currentToken);
        const response = await this._makeAndroidRequest(url, 'POST', params, JSON.stringify(postData));

        const header = response.data?.message?.header;
        if (header?.status_code !== 200) {
            throw new Error(`Login failed with status ${header?.status_code}: ${header?.hint || 'Unknown error'}`);
        }
        state.isLoggedIn = true;
        console.log('Android login successful.');
    }

    static async _initializeAndroidClient(account, env, retryCount = 0) {
        if (!account.EMAIL || !account.PASSWORD) {
            throw new Error('Android account requires EMAIL and PASSWORD.');
        }

        const key = `${account.EMAIL}:${account.NAMEID}`;

        let state = androidClientStates.get(key);
        if (!state) {
            state = {
                email: account.EMAIL,
                password: account.PASSWORD,
                currentToken: null,
                isLoggedIn: false
            };
            androidClientStates.set(key, state);
        }

        console.log('Initializing Musixmatch Android client...');
        try {
            const { loginNeeded, token } = await this._getAndroidToken(env, state);
            state.currentToken = token;

            if (loginNeeded) {
                await this._androidLogin(account, env, state);
            }

            console.log('Android initialization successful. Logged in.');
            return state;
        } catch (error) {
            console.error(`Android initialization failed: ${error.message}`);
            if (error.message.includes('401') && retryCount < 3) {
                console.log(`Received 401, attempting to refresh token and re-login (Attempt ${retryCount + 1})`);
                await this._clearAndroidToken(env, key);
                return await this._initializeAndroidClient(account, env, retryCount + 1);
            }
            throw error;
        }
    }

    static async _androidApiRequest(url, account, env, params = {}, body = null, method = 'GET') {
        const key = `${account.EMAIL}:${account.NAMEID}`;
        let state = androidClientStates.get(key);

        if (!state || !state.isLoggedIn) {
            console.warn('Not logged in. Attempting to initialize Android client...');
            state = await this._initializeAndroidClient(account, env);
        }

        const signedParams = this._buildAndroidSignedParams(url, params, state.currentToken);
        let response = await this._makeAndroidRequest(url, method, signedParams, body);

        const responseStatusCode = response.data?.message?.header?.status_code;

        if (response.http_code === 401 || responseStatusCode === 401) {
            console.log('Auth token expired or invalid (401). Refreshing token and re-logging in...');
            await this._clearAndroidToken(env, key);
            state = await this._initializeAndroidClient(account, env);

            const newSignedParams = this._buildAndroidSignedParams(url, params, state.currentToken);
            response = await this._makeAndroidRequest(url, method, newSignedParams, body);
        }

        if (response.data?.message?.header?.status_code !== 200) {
            throw new Error(`Android API error: ${response.data?.message?.header?.hint || 'Unknown error'} (${response.data?.message?.header?.status_code})`);
        }

        return response.data;
    }

    static async _androidSearchTrack(query, account, env) {
        const params = {
            q: query,
            part: 'track_artist,artist_image',
            track_fields_set: 'android_track_list',
            artist_fields_set: 'android_track_list_artist',
            page: 1,
            page_size: 5
        };

        const response = await this._androidApiRequest(`${ANDROID_BASE_URL}macro.search`, account, env, params);
        const trackList = response.message?.body?.macro_result_list?.track_list || [];
        return { message: { body: { track_list: trackList } } };
    }

    static async _androidGetSubtitle(trackId, account, env) {
        const params = {
            track_id: trackId,
            subtitle_format: 'lrc'
        };
        return await this._androidApiRequest(`${ANDROID_BASE_URL}track.subtitle.get`, account, env, params);
    }

    static async _androidGetRichsync(trackId, account, env) {
        const params = { track_id: trackId };
        return await this._androidApiRequest(`${ANDROID_BASE_URL}track.richsync.get`, account, env, params);
    }

    // --- Web API Implementation ---

    static async getUserToken(env) {
        try {
            const kvHandler = new DbHandler(env.LYRICSPLUS);
            const storedToken = await kvHandler.get(WEB_TOKEN_KEY);
            if (storedToken?.expiryTime > Date.now()) return storedToken.token;

            const currentAccount = musixmatchAccountManager.getCurrentAccount();
            if (!currentAccount) throw new Error('No Musixmatch account available.');

            const data = await this._makeWebRequest(new URL(`${WEB_BASE_URL}/token.get`), null, currentAccount);
            const token = data.message?.body?.user_token;
            if (!token || token.includes('UpgradeOnly')) throw new Error('Invalid token received from Musixmatch.');

            await kvHandler.set(WEB_TOKEN_KEY, { token, expiryTime: Date.now() + 3600000 }, 3600);
            return token;
        } catch (error) {
            console.error('Error getting user token:', error);
            throw error;
        }
    }

    static async _makeWebRequest(url, userToken = null, account) {
        url.searchParams.set('app_id', 'web-desktop-app-v1.0');
        if (userToken) url.searchParams.set('usertoken', userToken);

        if (!account) {
            account = musixmatchAccountManager.getCurrentAccount();
        }

        if (!account) throw new Error('No Musixmatch account available.');

        const response = await fetch(url.toString(), {
            headers: {
                'authority': 'apic-desktop.musixmatch.com',
                'User-Agent': account.USER_AGENT,
                'Cookie': account.COOKIE,
                'Origin': 'https://musixmatch.com',
            }
        });
        if (!response.ok) throw new Error(`Musixmatch Web API request failed with status ${response.status}`);
        const data = await response.json();
        if (data.message.header.status_code !== 200) throw new Error(`Musixmatch Web API error: ${data.message.header.hint || 'Unknown error'}`);
        return data;
    }

    // --- Shared Internal Helpers ---

    static async _checkCache(title, artist, album, duration, isrc, platformId, gd, forceReload, requireWordSync) {
        if (forceReload) return null;

        let file;
        const isIdOnlySearch = (!title || !artist) && (isrc || platformId);

        if (isIdOnlySearch) {
            file = await FileUtils.findExactMusixmatchByIds(gd, isrc, platformId);
        } else {
            file = await FileUtils.findExistingMusixmatch(gd, title, artist, album, duration, isrc, platformId);
        }

        if (file) {
            try {
                const content = await gd.fetchFile(file.id);
                if (content) {
                    const parsed = JSON.parse(content);
                    const converted = convertMusixmatchToJSON(parsed, requireWordSync);
                    if (converted && (!requireWordSync || converted.type === "Word")) {
                        converted.cached = 'GDrive';
                        return { success: true, data: converted, source: 'Musixmatch', rawData: parsed, existingFile: file };
                    }
                }
            } catch (error) {
                console.warn('Failed to process Musixmatch cache file:', error);
            }
        }
        return null;
    }

    static async _searchForBestMatch(title, artist, album, duration, songISRC, account, env) {
        const queries = [
            `${title} ${artist}`,
            title
        ];
        let candidates = [];
        for (const query of queries) {
            const searchResults = await this.searchTrack(query, account, env);
            const tracks = searchResults.message?.body?.track_list || searchResults.message?.body?.macro_result_list?.track_list || [];
            if (tracks.length > 0) {
                if (songISRC) {
                    for (const t of tracks) {
                        const track = t.track || t;
                        if (track.track_isrc === songISRC) {
                            return track;
                        }
                    }
                }

                candidates.push(...tracks.map(t => {
                    const track = t.track || t;
                    return {
                        attributes: {
                            name: track.track_name,
                            artistName: track.artist_name,
                            albumName: track.album_name,
                            durationInMillis: track.track_length * 1000
                        },
                        originalTrack: track
                    };
                }));
                const bestMatch = SimilarityUtils.findBestSongMatch(candidates, title, artist, album, duration, songISRC);
                if (bestMatch) return bestMatch.candidate.originalTrack;
            }
        }
        return null;
    }

    static async _fetchLyricsFromApi(trackId, account, env, requireWordSync) {
        try {
            const richLyrics = await this.getRichLyrics(trackId, account, env);
            if (richLyrics?.message?.body?.richsync) {
                return { lyrics: richLyrics, type: 'richsync' };
            }
        } catch (error) {
            console.warn('Failed to fetch richsync lyrics:', error);
        }

        if (!requireWordSync) {
            try {
                const subtitleLyrics = await this.getSubtitle(trackId, account, env);
                if (subtitleLyrics?.message?.body?.subtitle) {
                    return { lyrics: subtitleLyrics, type: 'subtitle' };
                }
            } catch (error) {
                console.warn('Failed to fetch subtitle lyrics:', error);
            }
        }

        return null;
    }
}