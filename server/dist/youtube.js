"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchYoutubeMeta = fetchYoutubeMeta;
exports.downloadYoutubeAudio = downloadYoutubeAudio;
const youtube_dl_exec_1 = __importDefault(require("youtube-dl-exec"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const ffmpeg_static_1 = __importDefault(require("ffmpeg-static"));
/**
 * 링크 확인 절차용: 실제로 다운로드하지 않고 메타데이터만 조회한다.
 * 방장이 "이 노래가 맞는지" 확인할 수 있도록 제목/썸네일/길이를 보여준다.
 */
async function fetchYoutubeMeta(url) {
    const info = await youtube_dl_exec_1.default(url, {
        dumpSingleJson: true,
        noWarnings: true,
        noCallHome: true,
        noCheckCertificates: true,
        preferFreeFormats: true,
        skipDownload: true,
    });
    return {
        title: info.title ?? "제목 없음",
        thumbnail: info.thumbnail ?? "",
        durationSec: Math.round(info.duration ?? 0),
    };
}
/**
 * 오디오만 추출해 uploadDir에 mp3로 저장한다.
 * 개인/소규모 용도라도 유튜브 이용약관을 확인하고 사용할 것.
 */
async function downloadYoutubeAudio(url, uploadDir, songId) {
    const outputTemplate = path_1.default.join(uploadDir, `${songId}.%(ext)s`);
    await youtube_dl_exec_1.default(url, {
        extractAudio: true,
        audioFormat: "mp3",
        audioQuality: 5,
        output: outputTemplate,
        ffmpegLocation: ffmpeg_static_1.default,
        noWarnings: true,
        noCallHome: true,
        noCheckCertificates: true,
    });
    const finalPath = path_1.default.join(uploadDir, `${songId}.mp3`);
    if (!fs_1.default.existsSync(finalPath)) {
        throw new Error("유튜브 오디오 추출 결과 파일을 찾을 수 없습니다.");
    }
    return finalPath;
}
