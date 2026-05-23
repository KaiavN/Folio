import React, { useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View, ActivityIndicator, Animated } from "react-native";

import { runSelectionHaptic, runImpactHaptic } from "./haptics.ts";
import type { SpeechRecognitionState } from "../engine/types.ts";

const PULSE_ANIMATION_DURATION_MS = 600;

type Props = {
  speechState: SpeechRecognitionState;
  onStartRecording: () => void;
  onStopRecording: () => void;
};

export function MicButton({ speechState, onStartRecording, onStopRecording }: Props) {
  const { status } = speechState;
  const isRecording = status === "recognizing";
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (isRecording) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.15,
            duration: PULSE_ANIMATION_DURATION_MS,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: PULSE_ANIMATION_DURATION_MS,
            useNativeDriver: true,
          }),
        ]),
      );
      pulse.start();
      return () => pulse.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isRecording, pulseAnim]);

  function handlePress() {
    runSelectionHaptic();
    if (isRecording) {
      runImpactHaptic("medium");
      onStopRecording();
    } else {
      onStartRecording();
    }
  }

  if (status === "processing") {
    return (
      <View style={[styles.micButton, styles.micButtonDisabled]}>
        <ActivityIndicator size="small" color="#F6F1E8" />
      </View>
    );
  }

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={isRecording ? "Stop recording" : "Start voice recording"}
      style={({ pressed }) => [
        styles.micButton,
        isRecording && styles.micButtonRecording,
        pressed && styles.buttonPressed,
      ]}
    >
      <Animated.View
        style={isRecording ? { transform: [{ scale: pulseAnim }] } : undefined}
      >
        {isRecording ? (
          <View style={styles.stopIcon} />
        ) : (
          <Text style={styles.micIcon}>mic</Text>
        )}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  micButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(231, 215, 192, 0.07)",
    alignItems: "center",
    justifyContent: "center",
  },
  micButtonRecording: {
    backgroundColor: "rgba(241, 157, 139, 0.4)",
  },
  micButtonDisabled: {
    opacity: 0.45,
  },
  buttonPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.95 }],
  },
  micIcon: {
    color: "#F6F1E8",
    fontSize: 16,
    fontWeight: "700",
  },
  stopIcon: {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: "#F6F1E8",
  },
});
