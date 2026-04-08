// services/lyricsPlusService.js
import { FileUtils } from "../utils/file.util.js";
import { v1Tov2, normalizeV2 } from "../parsers/kpoe.parser.js";
import { GDRIVE } from "../config.js";
import { logger } from '../utils/logger.util.js';

export class LyricsPlusService {

    static async fetchLyrics(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, gd, cacheOnly = false) {
        try {
            let userJsonFile;
            const isIdOnlySearch = (!songTitle || !songArtist) && (songISRC || songPlatformId);

            if (isIdOnlySearch) {
                userJsonFile = await FileUtils.findExactUserJSONByIds(gd, songISRC, songPlatformId);
            } else {
                userJsonFile = await FileUtils.findUserJSON(gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId);
            }

            if (userJsonFile) {
                const jsonContent = await gd.fetchFile(userJsonFile.id);
                if (jsonContent) {
                    let parsedJson = JSON.parse(jsonContent);

                    const isV1Format = parsedJson.lyrics?.length > 0 &&
                        typeof parsedJson.lyrics[0].syllabus === 'undefined';

                    // Convert v1 -> v2 first, then normalize either way.
                    // normalizeV2 is a no-op if the data is already in new format.
                    let lyricsData = normalizeV2(isV1Format ? v1Tov2(parsedJson) : parsedJson);

                    if (isV1Format) {
                        logger.debug("V1 lyrics format detected. Converted and normalized to V2.");
                    }

                    if (FileUtils.hasSyllableSync(lyricsData) || FileUtils.hasLineSync(lyricsData)) {
                        lyricsData.metadata = lyricsData.metadata || {};
                        lyricsData.metadata.source = 'Lyrics+';
                        lyricsData.cached = 'UserJSON';
                        return { success: true, data: lyricsData, source: 'lyricsplus' };
                    }
                }
            }
        } catch (error) {
            logger.warn('Failed to check user JSON:', error);
        }
        return null;
    }

    static async uploadTimelineLyrics(gd, songTitle, songArtist, songAlbum, songDuration, lyricsData, forceUpload = false, songISRC = null, songPlatformId = null) {
        try {
            if (!lyricsData.type || !lyricsData.metadata || !lyricsData.lyrics) {
                return { success: false, error: "Missing required fields: type or lyrics" };
            }

            // Ensure uploaded data is always in new format
            lyricsData = normalizeV2(lyricsData);

            const fileName = await FileUtils.generateUniqueFileName(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId);
            const fullFileName = `${fileName}.json`;

            const existingUGCFile = await FileUtils.findExistingFile(
                gd,
                songTitle,
                songArtist,
                songAlbum,
                songDuration,
                songISRC,
                songPlatformId,
                GDRIVE.USERTML_JSON,
                'application/json'
            );

            const isExactMatch = existingUGCFile && existingUGCFile.name === fullFileName;

            if (existingUGCFile && isExactMatch && forceUpload) {
                const previousContent = await gd.fetchFile(existingUGCFile.id);
                if (previousContent) {
                    const previousData = JSON.parse(previousContent);
                    if (this.isVandalismUpdate(previousData, lyricsData)) {
                        logger.warn("Vandalism detected in the update. Update aborted.");
                        return { success: false, error: "Vandalism detected. Update aborted." };
                    }
                }
                await gd.updateFile(existingUGCFile.id, JSON.stringify(lyricsData));
                logger.debug(`Updated existing file: ${fullFileName}`);
            } else if (!existingUGCFile || !isExactMatch) {
                await gd.uploadFile(
                    fullFileName,
                    'application/json',
                    JSON.stringify(lyricsData),
                    GDRIVE.USERTML_JSON
                );
                logger.debug(`Uploaded new file: ${fullFileName}`);
            } else {
                logger.debug("File already exists and forceUpload is false. No upload performed.");
                return { success: false, error: "File exists. Set forceUpload to true to update." };
            }
            return { success: true };
        } catch (error) {
            logger.error("Error uploading timeline lyrics:", error);
            return { success: false, error };
        }
    }

    static isVandalismUpdate(previousData, newData) {
        return false;
    }
}