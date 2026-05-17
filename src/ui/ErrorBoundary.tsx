import React, { type ReactNode } from 'react';
import { Text, View, StyleSheet, Pressable } from 'react-native';
import { darkColors as COLORS } from './colors';

type Props = {
  children: ReactNode;
  fallback?: ReactNode;
};

type State = {
  hasError: boolean;
  error?: Error;
};

export class ErrorBoundary extends React.Component<Props, State> {
  mounted = true;

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Folio ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.body}>
            {this.state.error?.message ?? 'An unexpected error occurred in the app.'}
          </Text>
          {this.state.error?.stack && (
            <Text style={styles.stack}>{this.state.error.stack}</Text>
          )}
          <Pressable
            onPress={this.handleReset}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bgDeep,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 16,
  },
  title: {
    color: COLORS.textPrimary,
    fontSize: 22,
    fontWeight: '800',
  },
  body: {
    color: COLORS.textSecondary,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  button: {
    backgroundColor: COLORS.accentPrimary,
    borderRadius: 999,
    paddingHorizontal: 24,
    paddingVertical: 14,
    marginTop: 8,
  },
  stack: {
    color: COLORS.textSecondary,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'left',
    fontFamily: 'monospace',
    backgroundColor: 'rgba(0,0,0,0.3)',
    padding: 12,
    borderRadius: 8,
    alignSelf: 'stretch',
    maxHeight: 200,
  },
  buttonText: {
    color: COLORS.chipTextOnAccent,
    fontSize: 15,
    fontWeight: '800',
  },
});
