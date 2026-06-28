import { QQService } from "./qq.service.js";
import { AppleMusicService } from "./appleMusic.service.js";
import { MusixmatchService } from "./musixmatch.service.js";
import { mergeAppleMetadataIntoWordSync } from "../utils/merge.util.js";
import { logger } from '../utils/logger.util.js';

function withTimeout(promise, ms, sourceStr) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout fetching from ${sourceStr}`)), ms))
    ]).catch(err => {
        logger.error(`QapleService: ${err.message}`);
        return null;
    });
}

export class QapleService {
    static async fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, env, sources) {
        logger.debug('QapleService: Attempting to fetch word-sync from QQ...');
        const qqResult = await withTimeout(
            QQService.fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, env, false),
            10000,
            'QQ'
        );

        if (!qqResult || !qqResult.success || !qqResult.data || !qqResult.data.lyrics) {
            logger.debug('QapleService: QQ word-sync fetch failed, aborting Qaple merge.');
            return null;
        }

        let lineSyncResult = null;
        let lineSyncSource = '';

        logger.debug('QapleService: Attempting to fetch line-sync from Apple Music...');
        const appleResult = await withTimeout(
            AppleMusicService.fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, sources || [], false),
            10000,
            'Apple Music'
        );

        if (appleResult && appleResult.success && appleResult.data && appleResult.data.lyrics) {
            lineSyncResult = appleResult.data;
            lineSyncSource = 'Apple';
        } else {
            logger.debug('QapleService: Apple Music fetch failed, falling back to Musixmatch line-sync...');
            const mxmResult = await withTimeout(
                MusixmatchService.fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, env, false, true),
                10000,
                'Musixmatch'
            );
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
