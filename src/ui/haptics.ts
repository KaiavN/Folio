import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

type ImpactTone = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft';
type NotificationTone = 'success' | 'warning' | 'error';

export function runSelectionHaptic() {
  if (Platform.OS === 'web') {
    return;
  }

  void Haptics.selectionAsync();
}

export function runImpactHaptic(tone: ImpactTone) {
  if (Platform.OS === 'web') {
    return;
  }

  const styleMap: Record<ImpactTone, Haptics.ImpactFeedbackStyle> = {
    light: Haptics.ImpactFeedbackStyle.Light,
    medium: Haptics.ImpactFeedbackStyle.Medium,
    heavy: Haptics.ImpactFeedbackStyle.Heavy,
    rigid: Haptics.ImpactFeedbackStyle.Rigid,
    soft: Haptics.ImpactFeedbackStyle.Soft,
  };

  void Haptics.impactAsync(styleMap[tone]);
}

export function runNotificationHaptic(tone: NotificationTone) {
  if (Platform.OS === 'web') {
    return;
  }

  const typeMap: Record<NotificationTone, Haptics.NotificationFeedbackType> = {
    success: Haptics.NotificationFeedbackType.Success,
    warning: Haptics.NotificationFeedbackType.Warning,
    error: Haptics.NotificationFeedbackType.Error,
  };

  void Haptics.notificationAsync(typeMap[tone]);
}
