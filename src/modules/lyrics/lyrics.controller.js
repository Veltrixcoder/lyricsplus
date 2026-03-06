
import { AppleMusicService } from "../../shared/services/appleMusic.service.js";
import { MusixmatchService } from "../../shared/services/musixmatch.service.js";
import { SpotifyService } from "../../shared/services/spotify.service.js";
import { QQService } from "../../shared/services/qq.service.js";
import { LyricsPlusService } from "../../shared/services/lyricsPlus.service.js";
import { FileUtils } from "../../shared/utils/file.util.js";
import { GDRIVE } from "../../shared/config.js";
import GoogleDrive from "../../shared/utils/googleDrive.util.js";

const gd = new GoogleDrive();

export async function fetchSongs(env) {
    let songs = await env.SONGS_KV.get('songList', { type: 'json' });
    if (!songs) {
        console.debug('Song list not found in KV, fetching from Google Drive...');
        const fileContent = await gd.fetchFile(GDRIVE.SONGS_FILE_ID);
        if (typeof fileContent === "string" && (fileContent.trim().startsWith("{") || fileContent.trim().startsWith("["))) {
            songs = JSON.parse(fileContent || "[]");
        } else {
            songs = fileContent || [];
        }
        await env.SONGS_KV.put('songList', JSON.stringify(songs));
        console.debug('Song list fetched from Google Drive and stored in KV.');
    } else {
        console.debug('Song list fetched from KV.');
    }
    return songs;
}

export async function safeFetchSongs(env) {
    try {
        return await fetchSongs(env);
    } catch (error) {
        console.warn("fetchSongs() failed, attempting to reload from cache:", error);
        return [];
    }
}

/**
 * Saves the best lyrics to Google Drive and updates the KV store.
 * @param {string} source - The source of the lyrics (e.g., 'apple', 'musixmatch', 'spotify').
 * @param {string} fileName - The base file name for the lyrics.
 * @param {object|string} rawData - The raw data fetched from the source (e.g., TTML, Spotify JSON, Musixmatch JSON).
 * @param {object} convertedData - The converted lyrics data in LyricsPlus format.
 * @param {object} existingFile - Information about an existing file in Google Drive, if found.
 * @param {object} gd - Google Drive handler.
 * @param {object} songTitle - Song title
 * @param {object} songArtist - Song artist
 * @param {object} songAlbum - Song album
 * @param {object} songDuration - Song duration
 * @param {string|null} songISRC - The ISRC of the song.
 * @param {string|null} songPlatformId - The platform-specific ID of the song.
 * @param {object} songs - Cached songs list
 * @param {object} env - The Hono context environment object.
 */
async function saveBestLyrics(source, fileName, rawData, convertedData, gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, songs, env) {
    let fileId;
    try {
        if (source === 'apple') {
            const existingFile = await FileUtils.findExistingTTML(gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId);
            if (existingFile) {
                fileId = await gd.updateFile(existingFile.id, rawData);
            } else {
                fileId = await gd.uploadFile(
                    `${fileName}.ttml`,
                    'application/xml',
                    rawData,
                    GDRIVE.CACHED_TTML
                );
            }

        } else if (source === 'musixmatch') {
            const existingFile = await FileUtils.findExistingFile(
                gd,
                songTitle,
                songArtist,
                songAlbum,
                songDuration,
                songISRC,
                songPlatformId,
                GDRIVE.CACHED_MUSIXMATCH,
                'application/json'
            );
            if (existingFile) {
                fileId = await gd.updateFile(existingFile.id, JSON.stringify(rawData));
            } else {
                fileId = await gd.uploadFile(
                    `${fileName}.json`,
                    'application/json',
                    JSON.stringify(rawData),
                    GDRIVE.CACHED_MUSIXMATCH
                );
            }
        }
        else if (source === 'spotify') {
            const existingFile = await FileUtils.findExistingFile(
                gd,
                songTitle,
                songArtist,
                songAlbum,
                songDuration,
                songISRC,
                songPlatformId,
                GDRIVE.CACHED_SPOTIFY,
                'application/json'
            );
            if (existingFile) {
                fileId = await gd.updateFile(existingFile.id, JSON.stringify(rawData));
            } else {
                fileId = await gd.uploadFile(
                    `${fileName}.json`,
                    'application/json',
                    JSON.stringify(rawData),
                    GDRIVE.CACHED_SPOTIFY
                );
            }
        }
        else if (source === 'qq') {
            const existingFile = await FileUtils.findExistingFile(
                gd,
                songTitle,
                songArtist,
                songAlbum,
                songDuration,
                songISRC,
                songPlatformId,
                GDRIVE.CACHED_QQ,
                'application/xml' // Or text/plain, keeping standard with GDrive APIs
            );
            if (existingFile) {
                fileId = await gd.updateFile(existingFile.id, rawData);
            } else {
                fileId = await gd.uploadFile(
                    `${fileName}.qrc`,
                    'application/xml',
                    rawData,
                    GDRIVE.CACHED_QQ
                );
            }
        }
        console.debug(`Successfully saved best lyrics from ${source} to Google Drive.`);
    } catch (error) {
        console.error(`Failed to save lyrics from ${source}:`, error);
    }
}

export async function handleSongLyrics(
    songTitle = "",
    songArtist = "",
    songAlbum = "",
    songDuration = "",
    songISRC = null,
    songPlatformId = null,
    songs,
    gd,
    preferredSources = [],
    forceReload = false,
    env
) {
    const initialFileName = await FileUtils.generateUniqueFileName(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId);
    console.debug('Looking for:', initialFileName, forceReload ? '(Force reload enabled)' : '');

    let sources;
    const isIdOnlySearch = (!songTitle || !songArtist) && (songISRC || songPlatformId);

    if (isIdOnlySearch) {
        sources = ['apple', 'lyricsplus', 'qq', 'musixmatch', 'spotify'];
    } else {
        sources = preferredSources.length > 0 ? preferredSources : ['apple', 'lyricsplus', 'qq', 'musixmatch-word', 'musixmatch', 'spotify'];
    }

    const getSyncPriority = (result) => {
        if (!result || !result.data) return 0;

        const sourceType = result.source ? result.source.toLowerCase() : '';
        const data = result.data;
        const syncType = data.type ? data.type.toUpperCase() : '';

        if (sourceType.includes('musixmatch') || sourceType.includes('spotify') || sourceType.includes('qq')) {
            if (syncType === 'WORD' || syncType === 'SYLLABLE') return 3;
            if (syncType === 'LINE') return 2;
            return 1;
        }

        if (sourceType.includes('apple') || sourceType.includes('lyricsplus')) {
            return FileUtils.hasSyllableSync(data) ? 3 : syncType == 'LINE' ? 2 : 1;
        }
    };

    const fetchSource = (source) => {
        switch (source) {
            case 'apple':
                console.debug(`Attempting AppleMusic Fetch`);
                return AppleMusicService.fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, songs, gd, forceReload, sources);
            case 'lyricsplus':
                console.debug(`Attempting LyricsPlus Fetch`);
                return LyricsPlusService.fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, gd);
            case 'musixmatch-word':
                console.debug(`Attempting MusixMatch (Word Sync) Fetch`);
                return MusixmatchService.fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, gd, forceReload, env, true);
            case 'musixmatch':
                console.debug(`Attempting MusixMatch (Line/Any Sync) Fetch`);
                return MusixmatchService.fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, gd, forceReload, env, false);
            case 'spotify':
                console.debug(`Attempting Spotify (as MusixMatch alt) Fetch`);
                return SpotifyService.fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, gd, forceReload);
            case 'qq':
                console.debug(`Attempting QQ Fetch`);
                return QQService.fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, gd, forceReload, env);
            default:
                return Promise.resolve(null);
        }
    };

    const saveResult = async (result) => {
        const exactSongTitle = result.exactMetadata?.title || result.data.metadata.title || songTitle;
        const exactSongArtist = result.exactMetadata?.artist || result.data.metadata.artist || songArtist;
        const exactSongAlbum = result.exactMetadata?.album || result.data.metadata.album || songAlbum;
        const exactSongDuration = result.exactMetadata?.durationMs ? result.exactMetadata.durationMs / 1000 : (result.data.metadata.durationMs ? result.data.metadata.durationMs / 1000 : songDuration);
        const exactSongISRC = result.exactMetadata?.isrc || result.data.metadata.isrc || songISRC;
        const exactSongPlatformId = result.exactMetadata?.platformId || result.data.metadata.platformId || songPlatformId;

        const finalFileName = await FileUtils.generateUniqueFileName(exactSongTitle, exactSongArtist, exactSongAlbum, exactSongDuration, exactSongISRC, exactSongPlatformId);

        if (result.rawData && result.data.cached !== 'GDrive' && result.data.cached !== 'Database') {
            saveBestLyrics(
                result.source.toLowerCase().replace('-word', ''),
                finalFileName,
                result.rawData,
                result.data,
                gd,
                exactSongTitle,
                exactSongArtist,
                exactSongAlbum,
                exactSongDuration,
                exactSongISRC,
                exactSongPlatformId,
                songs,
                env
            );
        }
    };

    const firstTwoSources = sources.slice(0, 2);
    const firstTwoPromises = firstTwoSources.map(source => fetchSource(source));

    const firstTwoResults = await Promise.all(firstTwoPromises.map(p => p.catch(e => {
        console.error(`Error fetching from one of the first two sources:`, e);
        return null;
    })));

    const successfulFirstTwoResults = firstTwoResults.filter(r => r && r.success && r.data && r.data.lyrics && r.data.lyrics.length > 0);

    if (successfulFirstTwoResults.length > 0) {
        const bestFirstTwo = successfulFirstTwoResults.reduce((best, current) => {
            const bestPriority = getSyncPriority(best);
            const currentPriority = getSyncPriority(current);
            return currentPriority > bestPriority ? current : best;
        });

        const bestPriority = getSyncPriority(bestFirstTwo);

        if (bestPriority === 3) {
            console.debug(`Found word/syllable sync lyrics from first two sources: ${bestFirstTwo.source}`);
            await saveResult(bestFirstTwo);
            return bestFirstTwo;
        }

        if (bestPriority === 2) {
            console.debug(`Found line sync lyrics from first two sources, checking for word sync in remaining sources`);

            const remainingSources = sources.slice(2).filter(s => s !== 'musixmatch' && s !== 'spotify');

            if (remainingSources.length > 0) {
                const remainingPromises = remainingSources.map(source => fetchSource(source));
                const remainingResults = await Promise.all(remainingPromises.map(p => p.catch(e => {
                    console.error(`Error fetching from remaining source:`, e);
                    return null;
                })));

                const successfulRemainingResults = remainingResults.filter(r => r && r.success && r.data && r.data.lyrics && r.data.lyrics.length > 0);

                if (successfulRemainingResults.length > 0) {
                    const bestRemaining = successfulRemainingResults.reduce((best, current) => {
                        const bestPriority = getSyncPriority(best);
                        const currentPriority = getSyncPriority(current);
                        return currentPriority > bestPriority ? current : best;
                    });

                    if (getSyncPriority(bestRemaining) === 3) {
                        console.debug(`Found word sync from remaining sources: ${bestRemaining.source}`);
                        await saveResult(bestRemaining);
                        return bestRemaining;
                    }
                }
            }

            console.debug(`Using line sync result from first two sources: ${bestFirstTwo.source}`);
            await saveResult(bestFirstTwo);
            return bestFirstTwo;
        }
    }

    console.debug('No suitable lyrics from first two sources or priority <= 1, fetching all remaining sources');
    const remainingSources = sources.slice(2);
    const promises = remainingSources.map(source => fetchSource(source));

    const results = await Promise.all(promises.map(p => p.catch(e => {
        console.error(`Error fetching from remaining source:`, e);
        return null;
    })));

    const allSuccessfulResults = [...successfulFirstTwoResults, ...results.filter(r => r && r.success && r.data && r.data.lyrics && r.data.lyrics.length > 0)];

    if (allSuccessfulResults.length > 0) {
        const bestResult = allSuccessfulResults.reduce((best, current) => {
            const bestPriority = getSyncPriority(best);
            const currentPriority = getSyncPriority(current);
            return currentPriority > bestPriority ? current : best;
        });

        await saveResult(bestResult);
        return bestResult;
    }

    return {
        success: false,
        status: 404,
        data: {
            message: `Lyrics not found in sources: ${sources.join(', ')}`,
            status: 404,
            details: {
                searchedSources: sources,
                songInfo: {
                    title: songTitle,
                    artist: songArtist,
                    album: songAlbum
                }
            }
        }
    };
}
