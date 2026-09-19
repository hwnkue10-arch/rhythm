import youtubeDl from "youtube-dl-exec";
import path from "path";
import fs from "fs";
import ffmpegPath from "ffmpeg-static";

export interface YoutubeMeta {
  title: string;
  thumbnail: string;
  durationSec: number;
}

/**
 * 링크 확인 절차용: 실제로 다운로드하지 않고 메타데이터만 조회한다.
 * 방장이 "이 노래가 맞는지" 확인할 수 있도록 제목/썸네일/길이를 보여준다.
 */
export async function fetchYoutubeMeta(url: string): Promise<YoutubeMeta> {
  const info: any = await (youtubeDl as any)(url, {
    dumpSingleJson: true,
    noWarnings: true,
    noCheckCertificates: true,
    preferFreeFormats: true,
    skipDownload: true,
    extractorArgs: "youtube:player_client=default",
    addHeader: [
      "referer:https://www.youtube.com/",
      "user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    ],
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
export async function downloadYoutubeAudio(url: string, uploadDir: string, songId: string): Promise<string> {
  const outputTemplate = path.join(uploadDir, `${songId}.%(ext)s`);
  await (youtubeDl as any)(url, {
    extractAudio: true,
    audioFormat: "mp3",
    audioQuality: 5,
    output: outputTemplate,
    ffmpegLocation: ffmpegPath as unknown as string,
    noWarnings: true,
    noCheckCertificates: true,
    extractorArgs: "youtube:player_client=default",
    addHeader: [
      "referer:https://www.youtube.com/",
      "user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    ],
  });
  const finalPath = path.join(uploadDir, `${songId}.mp3`);
  if (!fs.existsSync(finalPath)) {
    throw new Error("유튜브 오디오 추출 결과 파일을 찾을 수 없습니다.");
  }
  return finalPath;
}
