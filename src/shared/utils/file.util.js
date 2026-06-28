/**
 * A utility class for checking lyric sync formats.
 */
export class FileUtils {
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
