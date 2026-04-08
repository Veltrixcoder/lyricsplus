//placeholder, but this code are trying to check user-datas, and add ISRC code to the metadata of filename, so user data can be used on isrc lookup, and also for future use on lyrics fetching, and other metadata fetching, which can be used to improve the accuracy of the result.

import GoogleDrive from "../src/shared/utils/googleDrive.util.js"; 
import { GDRIVE } from "../src/shared/config.js";

const googleDrive = new GoogleDrive();

//