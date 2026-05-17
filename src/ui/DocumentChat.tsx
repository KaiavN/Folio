import React, { useState, useCallback } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, Alert, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ChatAttachment } from "../engine/types.ts";
import {
  pickDocument,
  getIndexedDocumentCount,
  clearDocumentIndex,
} from "../engine/documents/index.ts";
import {
  runImpactHaptic,
  runSelectionHaptic,
} from "./haptics.ts";
import { darkColors as COLORS } from "./colors.ts";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: ChatAttachment[];
  timestamp: number;
};

type DocumentChatProps = {
  onSendMessage: (
    message: string,
    attachments: ChatAttachment[],
  ) => Promise<string>;
  sessionId: string;
};

export function DocumentChat({ onSendMessage, sessionId }: DocumentChatProps) {
  const insets = useSafeAreaInsets();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [attachedDocs, setAttachedDocs] = useState<ChatAttachment[]>([]);

  const handleAttachDocument = useCallback(async () => {
    try {
      const result = await pickDocument();
      if (result.attachment && !result.error) {
        runSelectionHaptic();
        setAttachedDocs((prev) => [...prev, result.attachment!]);
      } else if (result.error) {
        Alert.alert("Error", result.error);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      Alert.alert("Error", message);
    }
  }, []);

  const handleRemoveAttachment = useCallback((id: string) => {
    runSelectionHaptic();
    setAttachedDocs((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleSend = useCallback(async () => {
    if (!input.trim() && attachedDocs.length === 0) return;

    runImpactHaptic("light");

    const userMessage: Message = {
      id: `msg_${Date.now()}`,
      role: "user",
      content: input.trim(),
      attachments: attachedDocs.length > 0 ? [...attachedDocs] : undefined,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      const response = await onSendMessage(
        userMessage.content,
        userMessage.attachments ?? [],
      );

      const assistantMessage: Message = {
        id: `msg_${Date.now()}_assistant`,
        role: "assistant",
        content: response,
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      Alert.alert("Error", message);
    } finally {
      setIsLoading(false);
    }
  }, [input, attachedDocs, onSendMessage]);

  const clearDocs = useCallback(() => {
    runSelectionHaptic();
    clearDocumentIndex();
    setAttachedDocs([]);
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Document Chat</Text>
        <Text style={styles.docCount}>
          {getIndexedDocumentCount()} docs indexed
        </Text>
      </View>

      {attachedDocs.length > 0 && (
        <View style={styles.attachmentsBar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {attachedDocs.map((doc) => (
              <View key={doc.id} style={styles.attachmentChip}>
                <Text style={styles.attachmentChipText} numberOfLines={1}>
                  {doc.name}
                </Text>
                <Pressable
                  onPress={() => handleRemoveAttachment(doc.id)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Remove attachment"
                  accessibilityHint={`Remove ${doc.name}`}
                >
                  <Text style={styles.removeButton}>×</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
          <Pressable
            onPress={clearDocs}
            style={styles.clearButton}
            accessibilityRole="button"
            accessibilityLabel="Clear all documents"
          >
            <Text style={styles.clearButtonText}>Clear all</Text>
          </Pressable>
        </View>
      )}

      <ScrollView style={styles.messages} contentContainerStyle={styles.messagesContent}>
        {messages.map((msg) => (
          <View
            key={msg.id}
            style={[
              styles.message,
              msg.role === "user" ? styles.userMessage : styles.assistantMessage,
            ]}
          >
            <Text style={styles.messageLabel}>
              {msg.role === "user" ? "You" : "Assistant"}
            </Text>
            <Text style={styles.messageContent}>{msg.content}</Text>
            {msg.attachments && msg.attachments.length > 0 && (
              <View style={styles.messageAttachments}>
                <Text style={styles.attachmentsLabel}>Attachments:</Text>
                {msg.attachments.map((a) => (
                  <Text key={a.id} style={styles.attachmentName}>
                    • {a.name}
                  </Text>
                ))}
              </View>
            )}
          </View>
        ))}

        {isLoading && (
          <View style={[styles.message, styles.assistantMessage]}>
            <Text style={styles.messageLabel}>Assistant</Text>
            <ActivityIndicator size="small" color="#9F9586" />
          </View>
        )}
      </ScrollView>

      <View style={[styles.inputArea, { paddingBottom: insets.bottom > 0 ? insets.bottom + 12 : 12 }]}>
        <Pressable
          onPress={handleAttachDocument}
          style={styles.attachButton}
          accessibilityRole="button"
          accessibilityLabel="Attach document"
        >
          <Text style={styles.attachButtonText}>+ Doc</Text>
        </Pressable>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Ask about your documents..."
          placeholderTextColor="#7C8799"
          multiline
          maxLength={2000}
        />
        <Pressable
          onPress={handleSend}
          style={[styles.sendButton, !input.trim() && attachedDocs.length === 0 && styles.sendButtonDisabled]}
          disabled={!input.trim() && attachedDocs.length === 0}
          accessibilityRole="button"
          accessibilityLabel="Send message"
        >
          <Text style={styles.sendButtonText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bgDeep,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(215, 193, 162, 0.08)",
  },
  title: {
    fontSize: 16,
    fontWeight: "700",
    color: COLORS.textPrimary,
  },
  docCount: {
    fontSize: 11,
    color: COLORS.textSecondary,
  },
  attachmentsBar: {
    flexDirection: "row",
    alignItems: "center",
    padding: 10,
    backgroundColor: COLORS.bgCard,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(215, 193, 162, 0.06)",
  },
  attachmentChip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(231, 215, 192, 0.12)",
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 8,
  },
  attachmentChipText: {
    color: COLORS.textPrimary,
    fontSize: 12,
    maxWidth: 120,
  },
  removeButton: {
    color: COLORS.accentPrimary,
    fontSize: 16,
    marginLeft: 6,
    fontWeight: "600",
  },
  clearButton: {
    marginLeft: "auto",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  clearButtonText: {
    color: "#F1B7A9",
    fontSize: 12,
  },
  messages: {
    flex: 1,
  },
  messagesContent: {
    flexGrow: 1,
    padding: 14,
  },
  message: {
    marginBottom: 10,
    padding: 12,
    borderRadius: 18,
    maxWidth: "82%",
  },
  userMessage: {
    alignSelf: "flex-end",
    backgroundColor: COLORS.accentPrimary,
  },
  assistantMessage: {
    alignSelf: "flex-start",
    backgroundColor: COLORS.bgCard,
  },
  messageLabel: {
    fontSize: 10,
    color: "#9F9586",
    marginBottom: 4,
    textTransform: "uppercase",
    fontWeight: "700",
  },
  messageContent: {
    fontSize: 14,
    lineHeight: 20,
    color: COLORS.textPrimary,
  },
  messageAttachments: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.1)",
  },
  attachmentsLabel: {
    fontSize: 10,
    color: "rgba(255,255,255,0.6)",
  },
  attachmentName: {
    fontSize: 10,
    color: "rgba(255,255,255,0.85)",
    marginTop: 2,
  },
  inputArea: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: "rgba(215, 193, 162, 0.08)",
    backgroundColor: COLORS.bgCard,
  },
  attachButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(231, 215, 192, 0.1)",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 8,
  },
  attachButtonText: {
    fontSize: 12,
    color: COLORS.accentPrimary,
    fontWeight: "700",
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 88,
    backgroundColor: "rgba(255, 248, 235, 0.04)",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    color: COLORS.textPrimary,
  },
  sendButton: {
    marginLeft: 8,
    height: 40,
    paddingHorizontal: 18,
    borderRadius: 20,
    backgroundColor: COLORS.accentPrimary,
    justifyContent: "center",
    alignItems: "center",
  },
  sendButtonDisabled: {
    backgroundColor: "rgba(231, 215, 192, 0.3)",
  },
  sendButtonText: {
    color: COLORS.accentOnDark,
    fontSize: 13,
    fontWeight: "700",
  },
});