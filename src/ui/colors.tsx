import React, { createContext, useContext } from "react";
import { useColorScheme, useWindowDimensions } from "react-native";

// =============================================================================
// RESPONSIVE SCALE — adapt to screen size
// =============================================================================
const PHONE_BREAKPOINT = 375;
const TABLET_BREAKPOINT = 680;
const LAPTOP_BREAKPOINT = 1024;

export function useResponsiveScale() {
	const { width, height } = useWindowDimensions();
	const isTablet = width >= TABLET_BREAKPOINT;
	const isLaptop = width >= LAPTOP_BREAKPOINT;
	const isLandscape = width > height;
	const horizontalScale = width / PHONE_BREAKPOINT;
	const verticalScale = height / 812; // iPhone 12 Pro height baseline
	const scale = Math.min(horizontalScale, verticalScale);
	const clampedScale = Math.min(Math.max(scale, 0.85), 1.35);
	return { width, height, isTablet, isLaptop, isLandscape, scale: clampedScale, horizontalScale };
}

export function useTypographyScale() {
	const { scale, isTablet } = useResponsiveScale();
	return {
		scale,
		fontScale: isTablet ? Math.min(scale, 1.15) : scale,
	};
}

// =============================================================================
// SPACING SCALE — semantic tokens for consistent spacing
// =============================================================================
export const spacing = {
	xxs: 4,
	xs: 8,
	sm: 12,
	md: 16,
	lg: 20,
	xl: 24,
	xxl: 32,
	xxxl: 48,
	xxxxl: 64,
} as const;

// Responsive spacing multiplier for larger screens
export function responsiveSpacing(base: typeof spacing): typeof spacing {
	return base; // Used with useResponsiveScale() for actual scaling
}

// =============================================================================
// TYPOGRAPHY SCALE — consistent text sizing and line heights
// =============================================================================
export const typography = {
	caption: {
		fontSize: 12,
		lineHeight: 16,
		fontWeight: "400" as const,
	},
	body: {
		fontSize: 15,
		lineHeight: 21, // 1.4x
		fontWeight: "400" as const,
	},
	subtitle: {
		fontSize: 17,
		lineHeight: 24,
		fontWeight: "500" as const,
	},
	title: {
		fontSize: 22,
		lineHeight: 28,
		fontWeight: "700" as const,
	},
	hero: {
		fontSize: 34,
		lineHeight: 44,
		fontWeight: "800" as const,
	},
	heroLarge: {
		fontSize: 38,
		lineHeight: 46,
		fontWeight: "800" as const,
	},
} as const;

// Responsive typography sizes for tablets/larger screens
export const responsiveTypography = {
	...typography,
	title: { ...typography.title, fontSize: 24, lineHeight: 30 },
	hero: { ...typography.hero, fontSize: 38, lineHeight: 48 },
	heroLarge: { ...typography.heroLarge, fontSize: 44, lineHeight: 52 },
} as const;

// =============================================================================
// ELEVATION / SHADOW SYSTEM — depth through shadows, not flat design
// =============================================================================
export const elevation = {
	subtle: {
		shadowColor: "#000",
		shadowOffset: { width: 0, height: 2 },
		shadowOpacity: 0.12,
		shadowRadius: 4,
		elevation: 3,
	},
	medium: {
		shadowColor: "#000",
		shadowOffset: { width: 0, height: 4 },
		shadowOpacity: 0.18,
		shadowRadius: 12,
		elevation: 6,
	},
	elevated: {
		shadowColor: "#000",
		shadowOffset: { width: 0, height: 8 },
		shadowOpacity: 0.22,
		shadowRadius: 24,
		elevation: 12,
	},
} as const;

// =============================================================================
// BORDER RADIUS TOKENS — consistent rounded corners
// =============================================================================
export const borderRadius = {
	sm: 12,
	md: 16,
	lg: 22,
	xl: 28,
	full: 999,
} as const;

// =============================================================================
// ANIMATION TIMING — consistent motion duration
// =============================================================================
export const animation = {
	fast: 150,
	normal: 250,
	slow: 400,
} as const;

// =============================================================================
// SPRING CONFIG — physics-based motion for native feel
// =============================================================================
export const spring = {
	modal: {
		damping: 15,
		stiffness: 150,
	},
	button: {
		damping: 20,
		stiffness: 300,
	},
	entrance: {
		damping: 18,
		stiffness: 200,
	},
} as const;

// =============================================================================
// COLOR SCHEMES
// =============================================================================
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