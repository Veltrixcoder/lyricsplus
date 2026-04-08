import { QQService } from "./qq.service.js";
import { AppleMusicService } from "./appleMusic.service.js";
import { MusixmatchService } from "./musixmatch.service.js";
import { mergeAppleMetadataIntoWordSync } from "../utils/merge.util.js";
import { logger } from '../utils/logger.util.js';
import { FileUtils } from "../utils/file.util.js";

function withTimeout(promise, ms, sourceStr) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout fetching from ${sourceStr}`)), ms))
    ]).catch(err => {
        logger.error(`QapleService: ${err.message}`);
        return null;
    });
}

async function saveResultIfNeeded(sourceStr, result, gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, env) {
    if (result && result.success && result.data && result.data.lyrics) {
        if (result.rawData && result.data.cached !== 'GDrive' && result.data.cached !== 'Database') {
            const exactSongTitle = result.exactMetadata?.title || result.data.metadata?.title || songTitle;
            const exactSongArtist = result.exactMetadata?.artist || result.data.metadata?.artist || songArtist;
            const exactSongAlbum = result.exactMetadata?.album || result.data.metadata?.album || songAlbum;
            const exactSongDuration = result.exactMetadata?.durationMs ? result.exactMetadata.durationMs / 1000 : (result.data.metadata?.durationMs ? result.data.metadata.durationMs / 1000 : songDuration);
            const exactSongISRC = result.exactMetadata?.isrc || result.data.metadata?.isrc || songISRC;
            const exactSongPlatformId = result.exactMetadata?.platformId || result.data.metadata?.platformId || songPlatformId;
            
            const fileName = await FileUtils.generateUniqueFileName(exactSongTitle, exactSongArtist, exactSongAlbum, exactSongDuration, exactSongISRC, exactSongPlatformId);
            
            await FileUtils.saveBestLyrics(sourceStr, fileName, result.rawData, result.data, gd, exactSongTitle, exactSongArtist, exactSongAlbum, exactSongDuration, exactSongISRC, exactSongPlatformId, env);
        }
    }
}

export class QapleService {
    static async fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, gd, forceReload, env, sources) {
        logger.debug('QapleService: Attempting to fetch word-sync from QQ...');
        const qqResult = await withTimeout(
            QQService.fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, gd, false, env, false),
            10000,
            'QQ'
        );
        await saveResultIfNeeded('qq', qqResult, gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, env);

        if (!qqResult || !qqResult.success || !qqResult.data || !qqResult.data.lyrics) {
            logger.debug('QapleService: QQ word-sync fetch failed, aborting Qaple merge.');
            return null;
        }

        let lineSyncResult = null;
        let lineSyncSource = '';

        logger.debug('QapleService: Attempting to fetch line-sync from Apple Music...');
        const appleResult = await withTimeout(
            AppleMusicService.fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, gd, false, sources || [], false),
            10000,
            'Apple Music'
        );
        await saveResultIfNeeded('apple', appleResult, gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, env);

        if (appleResult && appleResult.success && appleResult.data && appleResult.data.lyrics) {
            lineSyncResult = appleResult.data;
            lineSyncSource = 'Apple';
        } else {
            logger.debug('QapleService: Apple Music fetch failed, falling back to Musixmatch line-sync...');
            const mxmResult = await withTimeout(
                MusixmatchService.fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, gd, false, env, false, true),
                10000,
                'Musixmatch'
            );
            await saveResultIfNeeded('musixmatch', mxmResult, gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, env);
            if (mxmResult && mxmResult.success && mxmResult.data && mxmResult.data.lyrics) {
                lineSyncResult = mxmResult.data;
                lineSyncSource = 'Musixmatch';
            }
        }

        if (!lineSyncResult) {
            logger.debug('QapleService: No line-sync component available, aborting Qaple merge.');
            return null;
        }

        const mergedData = mergeAppleMetadataIntoWordSync(lineSyncResult, qqResult.data);

        if (!mergedData) {
            logger.debug('QapleService: Merge aborted (already word-synced). Returning null.');
            return null;
        }

        mergedData.metadata = mergedData.metadata || {};
        mergedData.metadata.source = `Lyrics+ (via ${lineSyncSource} with QQ)`;

        return {
            success: true,
            data: mergedData,
            source: 'qaple',
            exactMetadata: qqResult.exactMetadata
        };
    }
}
