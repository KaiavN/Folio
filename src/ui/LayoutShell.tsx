import React from "react";
import {
	KeyboardAvoidingView,
	Platform,
	StyleSheet,
	View,
	type ViewStyle,
	useWindowDimensions,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { spacing } from "./colors.tsx";

interface LayoutShellProps {
	children: React.ReactNode;
	style?: ViewStyle;
}

const HORIZONTAL_PADDING_BASE = spacing.xl; // 24px

export function LayoutShell({ children, style }: LayoutShellProps) {
	const insets = useSafeAreaInsets();
	const { width: screenWidth, height: screenHeight } = useWindowDimensions();
	const isTablet = screenWidth >= 680;
	const isLandscape = screenWidth > screenHeight;

	// Adaptive sizing
	const horizontalPadding = isTablet ? spacing.xxl : HORIZONTAL_PADDING_BASE;
	const topBuffer = Platform.OS === "ios" ? 14 : 10;
	const topInsetPadding = insets.top + topBuffer;
	const bottomInsetPadding = Math.max(14, insets.bottom + 10);

	// Responsive glow sizes
	const glowScale = isTablet ? 1.4 : 1;
	const glowTopSize = 220 * glowScale;
	const glowBottomSize = 200 * glowScale;

	return (
		<SafeAreaView style={styles.safeArea} edges={["left", "right"]}>
			<KeyboardAvoidingView
				style={[
					styles.keyboardView,
					{
						paddingTop: topInsetPadding,
						paddingBottom: bottomInsetPadding,
						paddingHorizontal: horizontalPadding,
					},
				]}
				behavior={Platform.OS === "ios" ? "padding" : "height"}
			>
				<View
					style={[
						styles.backgroundGlowTop,
						{
							width: glowTopSize,
							height: glowTopSize,
						},
					]}
				/>
				<View
					style={[
						styles.backgroundGlowBottom,
						{
							width: glowBottomSize,
							height: glowBottomSize,
							bottom: isLandscape ? 40 : 60,
						},
					]}
				/>
				<View style={[styles.content, style]}>{children}</View>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	safeArea: {
		flex: 1,
	},
	keyboardView: {
		flex: 1,
	},
	backgroundGlowTop: {
		position: "absolute",
		top: -80,
		right: -40,
		borderRadius: 999,
		backgroundColor: "rgba(212, 181, 137, 0.12)",
	},
	backgroundGlowBottom: {
		position: "absolute",
		left: -60,
		borderRadius: 999,
		backgroundColor: "rgba(143, 158, 114, 0.12)",
	},
	content: {
		flex: 1,
	},
});

export { spacing };