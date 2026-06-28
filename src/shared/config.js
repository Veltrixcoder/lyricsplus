
export const APPLE_MUSIC = {
    BASE_URL: "https://amp-api.music.apple.com/v1",
    EDGE_BASE_URL: "https://amp-api-edge.music.apple.com/v1",
    ACCOUNTS: [
        {
            NAMEID: "ExampleAndroid",
            AUTH_TYPE: "android", 
            ANDROID_AUTH_TOKEN: process.env.APPLE_MUSIC_ANDROID_AUTH_TOKEN || "",
            ANDROID_DSID: process.env.APPLE_MUSIC_ANDROID_DSID || "",
            ANDROID_USER_AGENT: process.env.APPLE_MUSIC_ANDROID_USER_AGENT || "Music/6.1 Android/15 model/XiaomiPOCOF1 build/1451 (dt:66)",
            ANDROID_COOKIE: process.env.APPLE_MUSIC_ANDROID_COOKIE || "",
            STOREFRONT: "in", //country example: id or en or us or in
        },
        {
            NAMEID: "ExampleWeb",
            AUTH_TYPE: "web",
            MUSIC_AUTH_TOKEN: process.env.APPLE_MUSIC_AUTH_TOKEN || "",
        }
    ]
};

export const SPOTIFY = {
    BASE_URL: "https://api.spotify.com/v1",
    LYRICS_URL: "https://spclient.wg.spotify.com/color-lyrics/v2/track/",
    AUTH_URL: "https://accounts.spotify.com/api/token",
    TOKEN_URL: "https://open.spotify.com/get_access_token?reason=transport&productType=web_player",
    ACCOUNTS: [
        {
            CLIENT_ID: process.env.SPOTIFY_CLIENT_ID || "cbdd4b5851cd4d0fa249cacc1ea7a0e4",
            CLIENT_SECRET: process.env.SPOTIFY_CLIENT_SECRET || "562d33b90615422ca4f6d703aacb45c9",
            COOKIE: process.env.SPOTIFY_COOKIE || "sp_t=96771266227b46d8b68ab1e033768973; sp_landing=https%3A%2F%2Fopen.spotify.com%2F%3Fsp_cid%3D96771266227b46d8b68ab1e033768973%26device%3Ddesktop; sp_dc=AQAiuYC-8wzOhvLxtqqEG2CvVpH9qQcg6xQVujJjrrjT9fFBfqcKwomXTCG8E1WQ8aDT6FpK7-DhAimIhjKkzi-I1wttxPRD-rAZ2UBDeDdRlWnr8u7xUShvqwUYWWU7TS8YoBSfaL2ujiBF-J98f8AbTv2Qc_0lOWwM_UQIQ7Gt47nfhJUsIMqHLobZHOcWrQKTi4qvIVXWdx-5AumB0w20g9vXdDPUunEcP_KtjeYm63ojJHXGKNAPCj3dTM-e54la5Vi5zaMGN60; sp_key=6a87c3b6-2224-41ad-b6d9-98a67e80c506; OptanonAlertBoxClosed=2025-03-21T14:19:54.213Z; OptanonConsent=isGpcEnabled=0&datestamp=Fri+Mar+21+2025+22%3A12%3A17+GMT%2B0700+(Western+Indonesia+Time)&version=202411.2.0&browserGpcFlag=0&isIABGlobal=false&hosts=&landingPath=NotLandingPage&groups=s00%3A1%2Cf00%3A1%2Cm00%3A1%2Ct00%3A1%2Ci00%3A1%2Cf11%3A1%2Cm03%3A1&geolocation=ID%3BJT&AwaitingReconsent=false"
        }
    ]
};

export const MUSIXMATCH = {
    ACCOUNTS: [
        {
            NAMEID: "Musixmatch-Guest",
            AUTH_TYPE: "web",
            USER_AGENT: process.env.MUSIXMATCH_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
            COOKIE: process.env.MUSIXMATCH_COOKIE || 'AWSELB=55578B011601B1EF8BC274C33F9043CA947F99DCFF0A80541772015CA2B39C35C0F9E1C932D31725A7310BCAEB0C37431E024E2B45320B7F2C84490C2C97351FDE34690157'
        }
    ]
};

export class AccountManager {
    constructor(accounts) {
        this.accounts = accounts;
        this.currentIndex = 0;
    }

    getCurrentAccount() {
        if (this.accounts.length === 0) {
            return null;
        }
        return this.accounts[this.currentIndex];
    }

    switchToNextAccount() {
        if (this.accounts.length <= 1) {
            console.warn("Only one account available, cannot switch.");
            return false;
        }
        this.currentIndex = (this.currentIndex + 1) % this.accounts.length;
        console.log(`Switched to account index: ${this.currentIndex}`);
        return true;
    }

    resetAccount() {
        this.currentIndex = 0;
        console.log("Account index reset to 0.");
    }
}

export const appleMusicAccountManager = new AccountManager(APPLE_MUSIC.ACCOUNTS);
export const spotifyAccountManager = new AccountManager(SPOTIFY.ACCOUNTS);
export const musixmatchAccountManager = new AccountManager(MUSIXMATCH.ACCOUNTS);
