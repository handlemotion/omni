import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { useRef, useState } from "react";

/**
 * On-device dictation into one field: `start` asks for the microphone and speech permissions the
 * first time, then streams what it hears to `onText` until the speaker pauses or `stop` is
 * called. Several fields may be mounted at once, so each hears only the session it started.
 */
export function useDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const mine = useRef(false);

  useSpeechRecognitionEvent("start", () => {
    if (mine.current) setListening(true);
  });
  useSpeechRecognitionEvent("result", (event) => {
    if (mine.current) onText(event.results[0]?.transcript ?? "");
  });
  useSpeechRecognitionEvent("end", () => {
    mine.current = false;
    setListening(false);
  });

  const start = async () => {
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) return false;
    mine.current = true;
    ExpoSpeechRecognitionModule.start({ interimResults: true, iosTaskHint: "search" });
    return true;
  };
  const stop = () => {
    if (mine.current) ExpoSpeechRecognitionModule.stop();
  };
  return { listening, start, stop };
}
