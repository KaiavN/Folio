import React, { createContext, useContext } from "react";
import { useColorScheme } from "react-native";

export const darkColors = {
	bgDeep: "#151310",
	bgCard: "#1B1713",
	bgCardRich: "#201C18",
	bgSubtle: "rgba(255, 248, 235, 0.04)",
	bgSubtleMid: "rgba(255, 248, 235, 0.06)",
	textPrimary: "#F6F1E8",
	textSecondary: "#AFA597",
	textTertiary: "#B8B0A2",
	textPlaceholder: "#7C8799",
	accentPrimary: "#E7D7C0",
	accentMid: "#D7C1A2",
	accentWarm: "#C9B08E",
	accentOnDark: "#241B14",
	accentLime: "#D6FF5F",
	chipTextOnAccent: "#2A211A",
	border: "rgba(215, 193, 162, 0.08)",
	borderMed: "rgba(215, 193, 162, 0.12)",
	errorText: "#F1B7A9",
	errorBg: "rgba(106, 53, 42, 0.24)",
	errorBorder: "rgba(241, 157, 139, 0.18)",
	successBg: "rgba(169, 178, 138, 0.18)",
	successText: "#DCE7B2",
} as const;

export const lightColors = {
	bgDeep: "#F6F1E8",
	bgCard: "#EDE5D8",
	bgCardRich: "#E5DDD0",
	bgSubtle: "rgba(37, 27, 20, 0.04)",
	bgSubtleMid: "rgba(37, 27, 20, 0.06)",
	textPrimary: "#151310",
	textSecondary: "#6B6560",
	textTertiary: "#8A8278",
	textPlaceholder: "#6B6560",
	accentPrimary: "#8B7355",
	accentMid: "#7A644A",
	accentWarm: "#69553F",
	accentOnDark: "#F6F1E8",
	accentLime: "#5A7A1A",
	chipTextOnAccent: "#3D2E1F",
	border: "rgba(37, 27, 20, 0.08)",
	borderMed: "rgba(37, 27, 20, 0.12)",
	errorText: "#8B3A2A",
	errorBg: "rgba(139, 58, 42, 0.12)",
	errorBorder: "rgba(139, 58, 42, 0.18)",
	successBg: "rgba(90, 122, 26, 0.12)",
	successText: "#3A5A10",
} as const;

export type ColorScheme = typeof darkColors;

type ColorsContextValue = ColorScheme;

const ColorsContext = createContext<ColorsContextValue>(darkColors);

export function ColorsProvider({ children }: { children: React.ReactNode }) {
	const colorScheme = useColorScheme();
	const colors = (colorScheme === "light" ? lightColors : darkColors) as ColorScheme;
	return (
		<ColorsContext.Provider value={colors}>{children}</ColorsContext.Provider>
	);
}

export function useColors(): ColorScheme {
	return useContext(ColorsContext);
}