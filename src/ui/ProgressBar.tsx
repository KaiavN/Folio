import React, { useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import { useColors } from "./colors.tsx";

export function ProgressBar({ progress }: { progress: number }) {
	const COLORS = useColors();
	const clampedProgress = Math.min(Math.max(progress, 0), 1);
	const animatedProgress = useRef(new Animated.Value(clampedProgress)).current;

	useEffect(() => {
		Animated.timing(animatedProgress, {
			toValue: clampedProgress,
			duration: 240,
			easing: Easing.out(Easing.cubic),
			useNativeDriver: false,
		}).start();
	}, [animatedProgress, clampedProgress]);

	const width = animatedProgress.interpolate({
		inputRange: [0, 1],
		outputRange: ["0%", "100%"],
	});

	return (
		<View
			style={{
				width: "100%",
				height: 6,
				borderRadius: 999,
				overflow: "hidden",
				backgroundColor: "rgba(255, 248, 235, 0.06)",
			}}
		>
			<Animated.View
				style={{
					height: "100%",
					borderRadius: 999,
					backgroundColor: COLORS.accentPrimary,
					width,
				}}
			/>
		</View>
	);
}