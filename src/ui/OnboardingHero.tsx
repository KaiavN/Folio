import React from "react";
import { Text, View } from "react-native";

interface OnboardingHeroProps {
	eyebrow: string;
	title: string;
	intro: string;
}

export function OnboardingHero({ eyebrow, title, intro }: OnboardingHeroProps) {
	return (
		<View style={styles.selectionHero}>
			<Text style={styles.selectionEyebrow}>{eyebrow}</Text>
			<Text style={styles.selectionTitle}>{title}</Text>
			<Text style={styles.selectionIntro}>{intro}</Text>
		</View>
	);
}

const styles = {
	selectionHero: {
		gap: 6,
		paddingTop: 4,
		paddingBottom: 2,
	},
	selectionIntro: {
		color: "#AFA597",
		fontSize: 14,
		lineHeight: 20,
		marginTop: 2,
	},
	selectionEyebrow: {
		color: "#D7C1A2",
		fontSize: 12,
		fontWeight: "800",
		textTransform: "uppercase",
		letterSpacing: 1.1,
	},
	selectionTitle: {
		color: "#F6F1E8",
		fontSize: 34,
		fontWeight: "800",
		lineHeight: 40,
	},
};