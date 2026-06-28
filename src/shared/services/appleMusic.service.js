import { APPLE_MUSIC, appleMusicAccountManager } from "../config.js";
import { convertTTMLtoJSON } from "../parsers/ttml.parser.js";
import { SimilarityUtils } from "../utils/similarity.util.js";
import { logger } from '../utils/logger.util.js';

const CACHE = { storefront: null, authToken: null };
const MAX_RETRIES = 3;
const SUGGESTIONS_BASE_URL = 'https://amp-api-edge.music.apple.com/v1';

export class AppleMusicService {

    // --- Public API ---

    static async fetchLyrics(originalSongTitle, originalSongArtist, originalSongAlbum, originalSongDuration, songISRC, songPlatformId, sources, cacheOnly = false) {
        try {
            if (cacheOnly) {
                logger.debug('AppleMusicService: cacheOnly is true and cache is disabled. Skipping remote fetch.');
                return null;
            }

            logger.debug('Searching Apple Music...');

            // Prioritize ISRC search when available
            let bestMatch = null;
            if (songISRC) {
                logger.debug(`Searching Apple Music by ISRC: ${songISRC}`);
                bestMatch = await this._searchByIsrc(songISRC);
            }

            // Fall back to title/artist search if ISRC didn't find anything
            if (!bestMatch) {
                const isIdOnlySearch = (!originalSongTitle || !originalSongArtist) && (songISRC || songPlatformId);
                if (isIdOnlySearch) {
                    logger.debug('ISRC search found no match and no title/artist provided. Aborting Apple Music search.');
                    return null;
                }
                bestMatch = await this._searchForBestMatch(originalSongTitle, originalSongArtist, originalSongAlbum, originalSongDuration);
            }

            if (!bestMatch) {
                logger.warn('No suitable match found in Apple Music search.');
                return null;
            }

            const { name, artistName, albumName, durationInMillis, isrc } = bestMatch.attributes;
            const appleMusicId = bestMatch.id;
            const exactMetadata = { title: name, artist: artistName, album: albumName, durationMs: durationInMillis, isrc: isrc, platformId: appleMusicId };
            logger.debug(`Selected match: ${artistName} - ${name} (Album: ${albumName}, Duration: ${durationInMillis / 1000}s, ISRC: ${isrc}, AppleMusicId: ${appleMusicId})`);

            if (bestMatch.attributes?.hasLyrics === false) {
                logger.debug(`Apple Music song has no lyrics (hasLyrics=false): ${artistName} - ${name}`);
                return null;
            }

            const storefront = await this.getStorefront();
            const lyricsResponse = await this.makeAppleMusicRequest(
                `${APPLE_MUSIC.BASE_URL}/catalog/${storefront}/songs/${appleMusicId}/syllable-lyrics?l%5Blyrics%5D=en-US&extend=ttmlLocalizations&l%5Bscript%5D=en-Latn`, {}
            );
            const lyricsData = await lyricsResponse.json();
            const ttml = lyricsData.data?.[0]?.attributes?.ttml || lyricsData.data?.[0]?.attributes?.ttmlLocalizations;

            if (!ttml) {
                logger.warn('Lyrics TTML not found in API response.');
                return null;
            }

            const convertedToJson = convertTTMLtoJSON(ttml);
            if (!convertedToJson.lyrics || convertedToJson.lyrics.length === 0) {
                logger.warn('Fetched lyrics are empty.');
                return null;
            }

            convertedToJson.metadata = convertedToJson.metadata || {};
            convertedToJson.metadata.source = 'Apple';
            convertedToJson.cached = 'None';

            return { success: true, data: convertedToJson, source: 'apple', rawData: ttml, exactMetadata };

        } catch (error) {
            logger.warn('Failed to fetch from Apple Music:', error);
            return null;
        }
    }

    static async searchSong(query, storefront) {
        if (!query) return { results: { songs: { data: [] } } };
        const response = await this.makeAppleMusicRequest(
            `${APPLE_MUSIC.BASE_URL}/catalog/${storefront}/search?types=songs&term=${encodeURIComponent(query)}`, {}
        );
        return response.json();
    }

    /**
     * Searches via the suggestions endpoint, which has more relaxed rate limits than the
     * standard search endpoint. Songs are returned pre-hydrated in `resources.songs`,
     * so no follow-up requests are needed.
     *
     * @returns {Array} Song objects matching Apple Music's song schema.
     */
    static async searchSongBySuggestions(query, storefront) {
        if (!query) return [];

        const params = new URLSearchParams({
            'art[url]': 'f',
            'fields[albums]': 'artistName,artwork,contentRating,name,playParams,url',
            'fields[artists]': 'url,name,artwork',
            'format[resources]': 'map',
            kinds: 'topResults',
            l: 'en-US',
            'limit[results:topResults]': '10',
            'omit[resource]': 'autos',
            platform: 'web',
            term: query,
            types: 'songs',
            with: 'naturalLanguage',
        });

        const url = `${SUGGESTIONS_BASE_URL}/catalog/${storefront}/search/suggestions?${params.toString()}`;
        const response = await this.makeAppleMusicRequest(url, {});
        const data = await response.json();

        const songResources = data.resources?.songs || {};
        const suggestions = data.results?.suggestions || [];

        // Extract song IDs from topResults suggestions, then look them up in the resource map
        const songs = suggestions
            .filter(s => s.kind === 'topResults' && s.content?.type === 'songs')
            .map(s => songResources[s.content.id])
            .filter(Boolean);

        logger.debug(`Apple Music suggestions search found ${songs.length} song(s) for query: "${query}"`);
        return songs;
    }

    // --- Core Request & Auth Logic ---

    static async makeAppleMusicRequest(url, options, retries = 0, rateLimitRetries = 0) {
        try {
            const headers = await this._getAuthHeaders();
            const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });

            if (!response.ok) {
                if (response.status === 503 && rateLimitRetries < MAX_RETRIES) {
                    const delay = 500 + Math.random() * 1500;
                    logger.warn(`Apple Music 503 rate limit, retrying in ${Math.round(delay)}ms (attempt ${rateLimitRetries + 1}/${MAX_RETRIES})...`);
                    await new Promise(r => setTimeout(r, delay));
                    return this.makeAppleMusicRequest(url, options, retries, rateLimitRetries + 1);
                }
                if ((response.status === 401 || response.status === 429) && retries < MAX_RETRIES) {
                    logger.warn(`Apple Music API call failed with status ${response.status}. Retrying with next account...`);
                    appleMusicAccountManager.switchToNextAccount();
                    CACHE.authToken = null;
                    CACHE.storefront = null;
                    return this.makeAppleMusicRequest(url, options, retries + 1, 0);
                }
                const errorText = await response.text();
                throw new Error(`Apple Music API returned status ${response.status}: ${errorText}`);
            }
            return response;
        } catch (error) {
            logger.error("Error in makeAppleMusicRequest:", error);
            throw error;
        }
    }

    static async getAppleMusicAuth() {
        const currentAccount = appleMusicAccountManager.getCurrentAccount();
        if (!currentAccount) throw new Error("No Apple Music account available.");
        if (currentAccount.AUTH_TYPE === "android") return currentAccount.ANDROID_AUTH_TOKEN;

        if (CACHE.authToken) return CACHE.authToken;

        try {
            const response = await fetch("https://music.apple.com/");
            const html = await response.text();
            const scriptTagMatch = html.match(/<script type="module" crossorigin src="(\/assets\/index[^"]+\.js)"><\/script>/);
            if (!scriptTagMatch?.[1]) throw new Error("Could not find Apple Music index script tag.");

            const scriptUrl = new URL(scriptTagMatch[1], "https://music.apple.com/").toString();
            const jsResponse = await fetch(scriptUrl);
            const jsContent = await jsResponse.text();

            const tokenVarMatch = jsContent.match(/e\.headers\.Authorization\s*=\s*`Bearer \${(.*?)}`/);
            if (!tokenVarMatch?.[1]) throw new Error("Could not find authorization token variable in script.");

            const tokenValueMatch = jsContent.match(new RegExp(`const ${tokenVarMatch[1]}\\s*=\\s*"([^"]+)"`));
            if (!tokenValueMatch?.[1]) throw new Error("Could not find authorization token value in script.");

            CACHE.authToken = tokenValueMatch[1];
            return CACHE.authToken;
        } catch (error) {
            logger.error("Error scraping Apple Music auth token:", error);
            throw error;
        }
    }

    static async getStorefront() {
        if (CACHE.storefront) return CACHE.storefront;
        const currentAccount = appleMusicAccountManager.getCurrentAccount();
        if (!currentAccount) throw new Error("No Apple Music account available.");

        if (currentAccount.AUTH_TYPE === "android" && currentAccount.STOREFRONT) {
            CACHE.storefront = currentAccount.STOREFRONT;
            return CACHE.storefront;
        }

        try {
            const response = await this.makeAppleMusicRequest("https://api.music.apple.com/v1/me/storefront", {});
            const data = await response.json();
            CACHE.storefront = data.data[0].id;
        } catch (err) {
            CACHE.storefront = currentAccount.STOREFRONT || "us";
            logger.warn(`Could not fetch storefront, falling back to: ${CACHE.storefront}`);
        }
        return CACHE.storefront;
    }

    // --- Data Fetching & Normalization ---

    static async fetchIsrc(songId, storefront) {
        try {
            const response = await this.makeAppleMusicRequest(`${APPLE_MUSIC.BASE_URL}/catalog/${storefront}/songs/${songId}`, {});
            const data = await response.json();
            return data.data?.[0]?.attributes || null;
        } catch (error) {
            logger.error("Error fetching Apple Music song details:", error);
            return null;
        }
    }

    static async normalizeAppleMusicSong(track, storefront) {
        const attributes = track.attributes;
        const fullSongAttributes = await this.fetchIsrc(track.id, storefront);

        return {
            id: { appleMusic: track.id },
            sourceId: track.id,
            title: attributes.name,
            artist: attributes.artistName,
            album: attributes.albumName,
            albumArtUrl: attributes.artwork?.url.replace('{w}', '300').replace('{h}', '300') || null,
            durationMs: attributes.durationInMillis,
            isrc: fullSongAttributes?.isrc || null,
            songwriters: fullSongAttributes?.songwriterNames || attributes.songwriterNames || attributes.composerName || [],
            availability: ['Apple Music'],
            externalUrls: { appleMusic: attributes.url }
        };
    }

    // --- Internal Helpers ---

    static async _getAuthHeaders() {
        const currentAccount = appleMusicAccountManager.getCurrentAccount();
        if (!currentAccount) throw new Error("No Apple Music account available.");

        if (currentAccount.AUTH_TYPE === "android") {
            return {
                Authorization: `Bearer ${currentAccount.ANDROID_AUTH_TOKEN}`,
                "x-dsid": currentAccount.ANDROID_DSID,
                "User-Agent": currentAccount.ANDROID_USER_AGENT,
                "Cookie": currentAccount.ANDROID_COOKIE,
                "Accept-Encoding": "gzip"
            };
        } else {
            return {
                Authorization: `Bearer ${await this.getAppleMusicAuth()}`,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
                Origin: 'https://music.apple.com',
                Referer: 'https://music.apple.com',
                'media-user-token': currentAccount.MUSIC_AUTH_TOKEN
            };
        }
    }

    static async _searchByIsrc(isrc) {
        try {
            const storefront = await this.getStorefront();
            const response = await this.makeAppleMusicRequest(
                `${APPLE_MUSIC.BASE_URL}/catalog/${storefront}/songs?filter[isrc]=${encodeURIComponent(isrc)}`, {}
            );
            const data = await response.json();
            const songs = data.data || [];
            if (songs.length > 0) {
                logger.debug(`Apple Music ISRC search found ${songs.length} result(s) for ISRC: ${isrc}`);
                return songs[0];
            }
            logger.debug(`Apple Music ISRC search found no results for ISRC: ${isrc}`);
            return null;
        } catch (error) {
            logger.warn('Apple Music ISRC search failed:', error);
            return null;
        }
    }

    static async _searchForBestMatch(title, artist, album, duration) {
        const storefront = await this.getStorefront();
        const searchQueries = [
            [title, artist, album].filter(Boolean).join(' '),
            [title, artist].filter(Boolean).join(' '),
            `${artist} ${title}`,
            title
        ];

        // Try the suggestions endpoint first (lower rate limits).
        // It returns up to 10 pre-hydrated songs per query, so we accumulate across
        // queries and short-circuit as soon as a confident match is found.
        // Queries are reversed (simplest first) because the suggestions endpoint
        // consistently returns better results for shorter terms.
        let candidates = [];
        try {
            for (const query of [...searchQueries].reverse()) {
                logger.debug(`Searching Apple Music suggestions with query: "${query}"`);
                const songs = await this.searchSongBySuggestions(query, storefront);
                candidates.push(...songs);
                const bestMatch = SimilarityUtils.findBestSongMatch(candidates, title, artist, album, duration);
                if (bestMatch) return bestMatch.candidate;
            }
        } catch (error) {
            logger.warn('Apple Music suggestions search failed, falling back to standard search:', error);
            candidates = [];
        }

        // Fall back to the standard search endpoint if suggestions yielded nothing.
        logger.debug('Suggestions search exhausted, falling back to standard search...');
        for (const query of searchQueries) {
            logger.debug(`Searching Apple Music (standard) with query: "${query}"`);
            const searchData = await this.searchSong(query, storefront);
            candidates.push(...(searchData.results?.songs?.data || []));
            const bestMatch = SimilarityUtils.findBestSongMatch(candidates, title, artist, album, duration);
            if (bestMatch) return bestMatch.candidate;
        }
        return null;
    }
}