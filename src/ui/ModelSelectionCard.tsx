import React from "react";
import { Pressable, Text, View } from "react-native";

import { StatusPill } from "./SetupArcade.tsx";

interface ModelSelectionCardProps {
	modelName: string;
	sizeLabel: string;
	estimatedSizeGb: number;
	isInstalled: boolean;
	footerMeta: string;
	onSelect: () => void;
}

export function ModelSelectionCard({
	modelName,
	sizeLabel,
	estimatedSizeGb,
	isInstalled,
	footerMeta,
	onSelect,
}: ModelSelectionCardProps) {
	return (
		<Pressable
			onPress={onSelect}
			accessibilityRole="button"
			accessibilityLabel={
				isInstalled ? `Open ${modelName}` : `Download ${modelName}`
			}
			style={({ pressed }) => [
				styles.selectionCard,
				styles.selectionCardPrimary,
				pressed ? styles.buttonPressed : null,
			]}
		>
			<View style={styles.selectionCardHeader}>
				<Text
					style={styles.selectionCardTitle}
					numberOfLines={1}
					ellipsizeMode="tail"
				>
					{modelName}
				</Text>
				<StatusPill
					label={isInstalled ? "Installed" : "Available now"}
					tone="success"
				/>
			</View>
			<Text style={styles.selectionCardMeta}>
				{sizeLabel} • ~{estimatedSizeGb} GB
			</Text>
			<View style={styles.selectionCardFooter}>
				<Text style={styles.selectionFooterMeta}>
					{isInstalled ? "Already on this device" : footerMeta}
				</Text>
				<Text style={styles.selectionFooterAction}>
					{isInstalled ? "Open chat →" : `Download ${modelName} →`}
				</Text>
			</View>
		</Pressable>
	);
}

const styles = {
	selectionCard: {
		gap: 12,
		borderRadius: 22,
		padding: 16,
	},
	selectionCardPrimary: {
		backgroundColor: "#201C18",
	},
	selectionCardHeader: {
		flexDirection: "row",
		alignItems: "flex-start",
		justifyContent: "space-between",
		gap: 10,
	},
	selectionCardTitle: {
		flex: 1,
		minWidth: 0,
		color: "#F6F1E8",
		fontSize: 22,
		fontWeight: "800",
		lineHeight: 27,
	},
	selectionCardMeta: {
		color: "#D8D0C4",
		fontSize: 14,
	},
	selectionCardFooter: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 10,
		paddingTop: 8,
	},
	selectionFooterMeta: {
		flexShrink: 1,
		minWidth: 0,
		color: "#B3A793",
		fontSize: 12,
		fontWeight: "700",
	},
	selectionFooterAction: {
		flexShrink: 0,
		color: "#F6F1E8",
		fontSize: 14,
		fontWeight: "800",
	},
	buttonPressed: {
		opacity: 0.7,
	},
};