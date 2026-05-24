/**
 * Speech recognition service wrapping @dev-amirzubair/react-native-voice.
 * Provides streaming transcription via native iOS Speech Framework / Android SpeechRecognizer.
 */
import Voice, {
  SpeechResultsEvent,
  SpeechErrorEvent,
} from '@dev-amirzubair/react-native-voice';
import { Platform, PermissionsAndroid } from 'react-native';

import type {
  SpeechRecognitionOptions,
  SpeechRecognitionResult,
} from './speechTypes.js';

export type { SpeechRecognitionOptions, SpeechRecognitionResult };

// Maximum recording duration before auto-stop (30 seconds)
const RECORDING_TIMEOUT_MS = 30000;

class SpeechRecognitionService {
  private sessionId = 0;
  private currentOnResult: ((result: SpeechRecognitionResult) => void) | null = null;
  private currentOnError: ((error: string) => void) | null = null;
  private currentSessionId = 0;
  private silenceTimeout: ReturnType<typeof setTimeout> | null = null;
  private isCurrentlyRecognizing = false;
  private finalTranscription = "";

  private clearSilenceTimeout() {
    if (this.silenceTimeout) {
      clearTimeout(this.silenceTimeout);
      this.silenceTimeout = null;
    }
  }

  private startSilenceTimeout(onAutoStop: () => void) {
    this.clearSilenceTimeout();
    this.silenceTimeout = setTimeout(() => {
      if (this.isCurrentlyRecognizing) {
        onAutoStop();
      }
    }, RECORDING_TIMEOUT_MS);
  }

  private setupVoiceCallbacks(onAutoStop: () => void) {
    const self = this;
    // Always re-register with fresh callbacks
    Voice.onSpeechResults = (event: SpeechResultsEvent) => {
      const value = event.value;
      if (!value) return;
      const transcription = value[0] ?? '';
      self.finalTranscription = transcription;
      if (self.currentOnResult) {
        self.currentOnResult({ transcription, isFinal: true });
      }
    };

    Voice.onSpeechPartialResults = (event: SpeechResultsEvent) => {
      const value = event.value;
      if (!value) return;
      const transcription = value[0] ?? '';
      self.finalTranscription = transcription;
      if (self.currentOnResult) {
        self.currentOnResult({ transcription, isFinal: false });
      }
      self.startSilenceTimeout(onAutoStop);
    };

    Voice.onSpeechEnd = () => {
      self.isCurrentlyRecognizing = false;
      self.clearSilenceTimeout();
    };

    Voice.onSpeechError = (event: SpeechErrorEvent) => {
      self.isCurrentlyRecognizing = false;
      self.clearSilenceTimeout();
      if (self.currentOnError) {
        const errObj = event.error as Record<string, unknown> | null | undefined;
        const message =
          typeof errObj === 'object' && errObj !== null
            ? typeof errObj.message === 'string'
              ? errObj.message
              : String(errObj)
            : 'Unknown speech error';
        self.currentOnError(message);
      }
    };
  }

  async startRecognition(options: SpeechRecognitionOptions): Promise<void> {
    const { onResult, onError, locale = 'en-US' } = options;
    this.currentOnResult = onResult;
    this.currentOnError = onError ?? null;
    const thisSession = ++this.sessionId;
    this.currentSessionId = thisSession;

    // Android permission check
    const hasPermission = await this.requestAndroidPermission();
    if (thisSession !== this.currentSessionId) return;
    if (!hasPermission) {
      if (this.currentOnError) {
        this.currentOnError('Microphone permission denied');
      }
      return;
    }

    // Check availability
    try {
      const isAvailable = await Voice.isAvailable();
      if (thisSession !== this.currentSessionId) return;
      if (!isAvailable) {
        if (this.currentOnError) {
          this.currentOnError('Speech recognition is not available on this device');
        }
        return;
      }
    } catch {
      if (thisSession !== this.currentSessionId) return;
      if (this.currentOnError) {
        this.currentOnError('Failed to check speech recognition availability');
      }
      return;
    }

    const self = this;
    this.setupVoiceCallbacks(async () => {
      if (thisSession !== self.currentSessionId) return;
      await self.stopRecognition();
    });

    try {
      this.isCurrentlyRecognizing = true;
      this.startSilenceTimeout(async () => {
        if (thisSession !== self.currentSessionId) return;
        if (!self.isCurrentlyRecognizing) return;
        self.isCurrentlyRecognizing = false;
        self.clearSilenceTimeout();
        try {
          await Voice.stop();
        } catch {
          // ignore stop errors
        }
      });
      await Voice.start(locale);
    } catch (error) {
      this.isCurrentlyRecognizing = false;
      this.clearSilenceTimeout();
      if (thisSession !== this.currentSessionId) return;
      if (this.currentOnError) {
        this.currentOnError(
          error instanceof Error ? error.message : 'Failed to start speech recognition',
        );
      }
    }
  }

  async stopRecognition(): Promise<string> {
    this.clearSilenceTimeout();
    if (!this.isCurrentlyRecognizing) {
      return this.finalTranscription;
    }
    this.isCurrentlyRecognizing = false;

    try {
      await Voice.stop();
    } catch {
      // ignore stop errors
    }

    const result = this.finalTranscription;
    this.finalTranscription = "";
    return result;
  }

  cancel(): void {
    this.clearSilenceTimeout();
    this.isCurrentlyRecognizing = false;
    this.finalTranscription = "";
    this.currentSessionId = 0;
    this.currentOnResult = null;
    this.currentOnError = null;
    try {
      Voice.destroy();
    } catch {
      // ignore destroy errors
    }
    try {
      Voice.cancel();
    } catch {
      // ignore cancel errors
    }
  }

  isRecognizing(): boolean {
    return this.isCurrentlyRecognizing;
  }

  private async requestAndroidPermission(): Promise<boolean> {
    if (Platform.OS !== 'android') return true;
    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        {
          title: 'Microphone Permission',
          message:
            'Folio needs microphone access to transcribe your voice messages.',
          buttonNeutral: 'Ask Me Later',
          buttonNegative: 'Cancel',
          buttonPositive: 'OK',
        },
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    } catch {
      return false;
    }
  }
}

export const speechService = new SpeechRecognitionService();

// Backwards compatibility - export service methods as standalone functions
export const startSpeechRecognition = (
  options: SpeechRecognitionOptions,
): Promise<void> => speechService.startRecognition(options);

export const stopSpeechRecognition = (): Promise<string> =>
  speechService.stopRecognition();

export const cancelSpeechRecognition = (): void => speechService.cancel();

export const isSpeechRecognizing = (): boolean => speechService.isRecognizing();