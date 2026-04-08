import { AppleMusicService } from "../../shared/services/appleMusic.service.js";
import { MusixmatchService } from "../../shared/services/musixmatch.service.js";
import { SpotifyService } from "../../shared/services/spotify.service.js";
import { QQService } from "../../shared/services/qq.service.js";
import { LyricsPlusService } from "../../shared/services/lyricsPlus.service.js";
import { QapleService } from "../../shared/services/qaple.service.js";
import { FileUtils } from "../../shared/utils/file.util.js";
import { GDRIVE } from "../../shared/config.js";
import GoogleDrive from "../../shared/utils/googleDrive.util.js";

import { logger } from '../../shared/utils/logger.util.js';

const gd = new GoogleDrive();


function raceWithEarlyExit(promises, getPriority, threshold) {
    if (promises.length === 0) {
        return Promise.resolve({ winner: null, all: [] });
    }
    
    return new Promise((resolve) => {
        const results = new Array(promises.length).fill(undefined);
        const pending = new Set(promises.map((_, i) => i));
        let won = false;

        const tryResolve = () => {
            if (won) return;

            const bestIdx = results.findIndex(
                (r, i) => !pending.has(i) && r && getPriority(r) >= threshold
            );

            if (bestIdx === -1) {
                if (pending.size === 0) resolve({ winner: null, all: results });
                return;
            }

            const blockedByEarlier = [...pending].some(i => i < bestIdx);
            if (blockedByEarlier) return;

            won = true;
            resolve({ winner: results[bestIdx], all: results });
        };

        promises.forEach((p, i) => {
            Promise.resolve(p)
                .catch(e => { logger.error(`Fetch error:`, e); return null; })
                .then(result => {
                    if (won) return;
                    results[i] = result;
                    pending.delete(i);
                    tryResolve();
                });
        });
    });
}

export async function handleSongLyrics(
    songTitle = "",
    songArtist = "",
    songAlbum = "",
    songDuration = "",
    songISRC = null,
    songPlatformId = null,
    gd,
    preferredSources = [],
    forceReload = false,
    env
) {
    const initialFileName = await FileUtils.generateUniqueFileName(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId);
    logger.debug('Looking for:', initialFileName, forceReload ? '(Force reload enabled)' : '');

    let sources;
    const isIdOnlySearch = (!songTitle || !songArtist) && (songISRC || songPlatformId);

    if (isIdOnlySearch) {
        sources = ['apple', 'lyricsplus', 'qq', 'musixmatch'];
    } else {
        sources = preferredSources.length > 0 ? preferredSources : ['apple', 'lyricsplus', 'qq', 'musixmatch-word', 'musixmatch'];
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

        if (sourceType.includes('apple') || sourceType.includes('lyricsplus') || sourceType.includes('qaple')) {
            return FileUtils.hasSyllableSync(data) ? 3 : syncType == 'LINE' ? 2 : 1;
        }
    };

    const fetchSource = (source) => {
        switch (source) {
            case 'apple':
                logger.debug(`Attempting AppleMusic Fetch`);
                return AppleMusicService.fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, gd, forceReload, sources);
            case 'lyricsplus':
                return (async () => {
                    logger.debug(`Attempting LyricsPlus Fetch`);
                    const lpResult = await LyricsPlusService.fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, gd);
                    if (lpResult && getSyncPriority(lpResult) === 3) {
                        return lpResult;
                    }
                    logger.debug(`Attempting Qaple Fetch (as part of LyricsPlus fallback)`);
                    const qapleResult = await QapleService.fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, gd, forceReload, env, sources);

                    // Only prefer qaple if it's actually better than what LyricsPlus found
                    if (qapleResult && getSyncPriority(qapleResult) > getSyncPriority(lpResult)) {
                        return qapleResult;
                    }
                    return lpResult;
                })();
            case 'musixmatch-word':
                logger.debug(`Attempting MusixMatch (Word Sync) Fetch`);
                return MusixmatchService.fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, gd, forceReload, env, true);
            case 'musixmatch':
                logger.debug(`Attempting MusixMatch (Line/Any Sync) Fetch`);
                return MusixmatchService.fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, gd, forceReload, env, false);
            case 'spotify':
                logger.debug(`Attempting Spotify (as MusixMatch alt) Fetch`);
                return SpotifyService.fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, gd, forceReload);
            case 'qq':
                logger.debug(`Attempting QQ Fetch`);
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

        if (result.rawData && result.data.cached !== 'GDrive' && result.data.cached !== 'Database' && result.source !== 'qaple') {
            FileUtils.saveBestLyrics(
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
                env
            );
        }
    };

    const isValidResult = (r) => r && r.success && r.data && r.data.lyrics && r.data.lyrics.length > 0;

    const firstTwoSources = sources.slice(0, 2);
    const firstTwoPromises = firstTwoSources.map(source => fetchSource(source));

    const { winner: earlyWinner, all: firstTwoResults } = await raceWithEarlyExit(
        firstTwoPromises,
        (r) => isValidResult(r) ? getSyncPriority(r) : 0,
        3
    );

    if (earlyWinner) {
        await saveResult(earlyWinner);
        return earlyWinner;
    }

    const successfulFirstTwo = firstTwoResults.filter(isValidResult);

    if (successfulFirstTwo.length > 0) {
        const bestFirstTwo = successfulFirstTwo.reduce((best, cur) =>
            getSyncPriority(cur) > getSyncPriority(best) ? cur : best
        );
        const bestPriority = getSyncPriority(bestFirstTwo);

        if (bestPriority === 2) {
            logger.debug(`Found line sync from first two sources, checking for word sync in remaining sources`);
            const remainingSources = sources.slice(2).filter(s => s !== 'musixmatch' && s !== 'spotify');

            if (remainingSources.length > 0) {
                const { winner: remainingWinner, all: remainingResults } = await raceWithEarlyExit(
                    remainingSources.map(source => fetchSource(source)),
                    (r) => isValidResult(r) ? getSyncPriority(r) : 0,
                    3
                );

                if (remainingWinner) {
                    logger.debug(`Found word sync from remaining sources: ${remainingWinner.source}`);
                    await saveResult(remainingWinner);
                    return remainingWinner;
                }
            }

            logger.debug(`Using line sync result from first two sources: ${bestFirstTwo.source}`);
            await saveResult(bestFirstTwo);
            return bestFirstTwo;
        }
    }

    logger.debug('No suitable lyrics from first two sources or priority <= 1, fetching all remaining sources');
    const remainingSources = sources.slice(2);

    const { winner: remainingEarlyWinner, all: remainingResults } = await raceWithEarlyExit(
        remainingSources.map(source => fetchSource(source)),
        (r) => isValidResult(r) ? getSyncPriority(r) : 0,
        3
    );

    if (remainingEarlyWinner) {
        await saveResult(remainingEarlyWinner);
        return remainingEarlyWinner;
    }

    const allSuccessful = [
        ...successfulFirstTwo,
        ...remainingResults.filter(isValidResult)
    ];

    if (allSuccessful.length > 0) {
        const bestResult = allSuccessful.reduce((best, cur) =>
            getSyncPriority(cur) > getSyncPriority(best) ? cur : best
        );
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