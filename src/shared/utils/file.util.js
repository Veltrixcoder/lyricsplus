// utils/fileUtils.js
import { GDRIVE } from "../config.js";
import { SimilarityUtils } from "./similarity.util.js";

/**
 * A utility class for handling file operations, specifically for generating filenames
 * and finding existing files on Google Drive based on song metadata.
 */
export class FileUtils {
    /**
     * Parses a structured song filename into its constituent parts.
     * @param {string} filename - The filename to parse (e.g., "Artist - Title [Album] (185.75).ext").
     * @returns {object} An object containing the parsed title, artist, album, and duration.
     * @private
     */
    static _parseFileName(filename) {
        const fileInfo = {
            title: undefined,
            artist: undefined,
            album: undefined,
            duration: undefined,
            isrc: undefined,
            platformId: undefined,
        };

        const nameWithoutExt = filename.includes('.') ? filename.substring(0, filename.lastIndexOf('.')) : filename;

        const isrcPlatformMatch = nameWithoutExt.match(/<([^>]+?)::([^>]+?)>$/);
        let nameWithoutIsrcPlatform = nameWithoutExt;
        if (isrcPlatformMatch) {
            fileInfo.isrc = isrcPlatformMatch[1] === 'null' ? undefined : isrcPlatformMatch[1].trim();
            fileInfo.platformId = isrcPlatformMatch[2] === 'null' ? undefined : isrcPlatformMatch[2].trim();
            nameWithoutIsrcPlatform = nameWithoutExt.replace(/<[^>]+?::[^>]+?>$/, '').trim();
        }

        const durationMatch = nameWithoutIsrcPlatform.match(/\s\((\d+(?:\.\d+)?)\)$/);
        let nameWithoutDuration = nameWithoutIsrcPlatform;
        if (durationMatch) {
            fileInfo.duration = parseFloat(durationMatch[1]);
            nameWithoutDuration = nameWithoutIsrcPlatform.replace(/\s\(\d+(?:\.\d+)?\)$/, '');
        }

        const albumMatch = nameWithoutDuration.match(/\s\[([^\]]+)\]$/);
        let nameWithoutAlbum = nameWithoutDuration;
        if (albumMatch) {
            fileInfo.album = albumMatch[1].trim();
            nameWithoutAlbum = nameWithoutDuration.replace(/\s\[[^\]]+\]$/, '');
        }

        const artistTitleMatch = nameWithoutAlbum.match(/^(.+?)\s*-\s*(.+)$/);
        if (artistTitleMatch) {
            fileInfo.artist = artistTitleMatch[1].trim();
            fileInfo.title = artistTitleMatch[2].trim();
        } else {
            fileInfo.title = nameWithoutAlbum.trim();
        }

        return fileInfo;
    }

    /**
     * Generates a unique, filesystem-safe filename from song metadata.
     * @param {string} songTitle - The title of the song.
     * @param {string} songArtist - The artist of the song.
     * @param {string|null} songAlbum - The album of the song.
     * @param {number|null} songDuration - The duration of the song in seconds.
     * @param {string|null} songISRC - The ISRC of the song.
     * @param {string|null} songPlatformId - The platform-specific ID of the song.
     * @returns {string} A sanitized, unique filename.
     */
    static async generateUniqueFileName(songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId) {
        if (!songTitle || !songArtist) {
            console.warn("Missing song title or artist for filename generation.");
            return `unknown-${Date.now()}`;
        }

        function cleanup(text) {
            return text.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim()
        }

        const albumPart = songAlbum ? ` [${cleanup(songAlbum)}]` : '';
        const durationPart = songDuration ? ` (${formatDuration(songDuration)})` : '';
        const isrcPart = (songISRC != null) ? String(songISRC).trim() : 'null';
        const platformIdPart = (songPlatformId != null) ? String(songPlatformId).trim() : 'null';
        const isrcPlatformPart = ` <${isrcPart}::${platformIdPart}>`;

        const filename = `${cleanup(songArtist)} - ${cleanup(songTitle.trim())}${albumPart}${durationPart}${isrcPlatformPart}`;

        return filename.trim();
    }

    /**
     * Searches for an existing file on Google Drive based on an exact match of ISRC or platform ID.
     * @param {object} gd - An authenticated Google Drive API instance.
     * @param {string|null} songISRC - The ISRC of the song to search for.
     * @param {string|null} songPlatformId - The platform-specific ID of the song.
     * @param {string} folderID - The ID of the Google Drive folder to search in.
     * @param {string} mimeType - The MIME type of the file to search for.
     * @returns {Promise<object|null>} The matching file object or null if not found.
     */
    static async findExactMatchByIds(gd, songISRC, songPlatformId, folderID, mimeType) {
        if (!gd) throw new Error("Google Drive instance is not provided.");
        if (!folderID) throw new Error("Folder ID is not provided.");
        if (!mimeType) throw new Error("MIME type is not provided.");
        if (!songISRC && !songPlatformId) return null;

        try {
            let queryParts = [`mimeType = '${mimeType}'`, `'${folderID}' in parents`];
            let searchTerm = songISRC || songPlatformId;

            queryParts.push(`name contains '${searchTerm}'`);

            const query = queryParts.join(' and ');
            const { files } = await gd.searchFiles(query);

            if (!files || files.length === 0) return null;

            for (const file of files) {
                const parsed = FileUtils._parseFileName(file.name);
                if (songISRC && parsed.isrc === songISRC) {
                    return file;
                }
                if (songPlatformId && parsed.platformId === songPlatformId) {
                    return file;
                }
            }

            return null;
        } catch (error) {
            console.error("Error searching for exact match by ID:", error);
            return null;
        }
    }

    /**
     * Searches for an existing file on Google Drive based on song metadata.
     * @param {object} gd - An authenticated Google Drive API instance.
     * @param {string} songTitle - The title of the song to search for.
     * @param {string} songArtist - The artist of the song.
     * @param {string|null} songAlbum - The album of the song.
     * @param {number|null} songDuration - The duration of the song in seconds.
     * @param {string|null} songISRC - The ISRC of the song.
     * @param {string|null} songPlatformId - The platform-specific ID of the song.
     * @param {string} folderID - The ID of the Google Drive folder to search in.
     * @param {string} mimeType - The MIME type of the file to search for.
     * @returns {Promise<object|null>} The best matching file object or null if not found.
     */
    static async findExistingFile(gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, folderID, mimeType) {
        if (!gd) throw new Error("Google Drive instance is not provided.");
        if (!folderID) throw new Error("Folder ID is not provided.");
        if (!mimeType) throw new Error("MIME type is not provided.");
        if (!songTitle || !songArtist) return null;

        try {
            const createKeywords = (text) => String(text || '').split(' ').filter(w => w.length > 3).slice(0, 2);
            const keywords = [
                ...createKeywords(songTitle),
                ...createKeywords(songArtist),
                ...createKeywords(songAlbum)
            ].map(k => k.replace(/'/g, "\\'"));

            if (keywords.length === 0) return null;

            const query = `${keywords.map(k => `name contains '${k}'`).join(' and ')} and mimeType = '${mimeType}' and '${folderID}' in parents`;
            const { files } = await gd.searchFiles(query);

            if (!files || files.length === 0) return null;

            const adaptedCandidates = files.map(file => {
                const parsed = FileUtils._parseFileName(file.name);
                return {
                    attributes: {
                        name: parsed.title,
                        artistName: parsed.artist,
                        albumName: parsed.album,
                        durationInMillis: parsed.duration ? parsed.duration * 1000 : undefined,
                        isrc: parsed.isrc,
                        platformId: parsed.platformId,
                    },
                    originalFile: file,
                };
            });

            const bestMatch = SimilarityUtils.findBestSongMatch(
                adaptedCandidates,
                songTitle,
                songArtist,
                songAlbum,
                songDuration,
                songISRC,
                songPlatformId
            );

            if (bestMatch?.scoreInfo?.score > 0) {
                console.debug("Top file match found with score:", bestMatch.scoreInfo.score);
                return bestMatch.candidate.originalFile;
            }

            return null;
        } catch (error) {
            console.error("Error searching for existing file:", error);
            return null;
        }
    }

    // --- Specific File Type Finders ---
    
    /**
     * Saves the best lyrics to Google Drive.
     * @param {string} source - The source of the lyrics (e.g., 'apple', 'musixmatch', 'spotify').
     * @param {string} fileName - The base file name for the lyrics.
     * @param {object|string} rawData - The raw data fetched from the source.
     * @param {object} convertedData - The converted lyrics data.
     * @param {object} gd - Google Drive handler.
     * @param {string} songTitle - Song title
     * @param {string} songArtist - Song artist
     * @param {string} songAlbum - Song album
     * @param {number} songDuration - Song duration
     * @param {string|null} songISRC - The ISRC of the song.
     * @param {string|null} songPlatformId - The platform-specific ID of the song.
     * @param {object} env - The Hono context environment object.
     */
    static async saveBestLyrics(source, fileName, rawData, convertedData, gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, env) {
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
                    gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, GDRIVE.CACHED_MUSIXMATCH, 'application/json'
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
            } else if (source === 'spotify') {
                const existingFile = await FileUtils.findExistingFile(
                    gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, GDRIVE.CACHED_SPOTIFY, 'application/json'
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
            } else if (source === 'qq') {
                const existingFile = await FileUtils.findExistingFile(
                    gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, GDRIVE.CACHED_QQ, 'application/xml'
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
            console.log(`[ASYNC] Successfully saved best lyrics for song ${songTitle} by ${songArtist} from ${source} to Google Drive.`);
        } catch (error) {
            console.error(`[ASYNC] Failed to save lyrics from ${source}:`, error);
        }
    }

    static async findExistingTTML(gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId) {
        return this.findExistingFile(gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, GDRIVE.CACHED_TTML, 'application/xml');
    }

    static async findExistingSp(gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId) {
        return this.findExistingFile(gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, GDRIVE.CACHED_SPOTIFY, 'application/json');
    }

    static async findExistingMusixmatch(gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId) {
        return this.findExistingFile(gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, GDRIVE.CACHED_MUSIXMATCH, 'application/json');
    }

    static async findExistingQq(gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId) {
        return this.findExistingFile(gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, GDRIVE.CACHED_QQ, 'application/xml');
    }

    static async findUserJSON(gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId) {
        return this.findExistingFile(gd, songTitle, songArtist, songAlbum, songDuration, songISRC, songPlatformId, GDRIVE.USERTML_JSON, 'application/json');
    }

    static async findExactTTMLByIds(gd, songISRC, songPlatformId) {
        return this.findExactMatchByIds(gd, songISRC, songPlatformId, GDRIVE.CACHED_TTML, 'application/xml');
    }

    static async findExactSpByIds(gd, songISRC, songPlatformId) {
        return this.findExactMatchByIds(gd, songISRC, songPlatformId, GDRIVE.CACHED_SPOTIFY, 'application/json');
    }

    static async findExactMusixmatchByIds(gd, songISRC, songPlatformId) {
        return this.findExactMatchByIds(gd, songISRC, songPlatformId, GDRIVE.CACHED_MUSIXMATCH, 'application/json');
    }

    static async findExactQqByIds(gd, songISRC, songPlatformId) {
        return this.findExactMatchByIds(gd, songISRC, songPlatformId, GDRIVE.CACHED_QQ, 'application/xml');
    }

    static async findExactUserJSONByIds(gd, songISRC, songPlatformId) {
        return this.findExactMatchByIds(gd, songISRC, songPlatformId, GDRIVE.USERTML_JSON, 'application/json');
    }

    // --- JSON Content Checks ---

    /**
     * Checks if a given JSON object contains word-level or syllable-level sync data.
     * @param {object} json - The JSON object to check.
     * @returns {boolean} True if syllable sync information is present.
     */
    static hasSyllableSync(json) {
        return !!json && (json.type === "Word" || json.type === "syllable");
    }

    /**
     * Checks if a given JSON object contains line-level sync data.
     * @param {object} json - The JSON object to check.
     * @returns {boolean} True if line sync information is present.
     */
    static hasLineSync(json) {
        return !!json && (json.type === "Line");
    }
}

/**
 * Formats a duration in seconds to a string with two decimal places.
 * @param {number} durationInSeconds - The duration in seconds.
 * @returns {string} The formatted duration string, or an empty string if input is invalid.
 * @private
 */
function formatDuration(durationInSeconds) {
    if (durationInSeconds === undefined || durationInSeconds === null) return '';
    return Number(durationInSeconds).toFixed(2);
}
