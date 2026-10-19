import type { MessageKey } from "./zh-CN.ts";

export const en: Record<MessageKey, string> = {
  "app.loading": "Opening database…",
  "app.loadFailed": "Failed to open the database",
  "characters.title": "Characters",
  "characters.import": "Import card",
  "characters.empty": "No characters yet. Import a character card to start.",
  "chats.title": "Chats",
  "chats.new": "New chat",
  "chats.import": "Import chat",
  "chats.empty": "No chats yet.",
  "chats.untitled": "Chat {date}",
  "chat.empty": "Pick a chat.",
  "chat.placeholder": "Write something…",
  "chat.send": "Send",
  "chat.you": "You",
  "chat.branch": "{index}/{total}",
  "chat.previous": "Previous alternative",
  "chat.next": "Next alternative",
  "error.card.unknown_format":
    "Unrecognized file. Only PNG, JSON and CHARX character cards are supported.",
  "error.card.invalid_json": "The JSON in this file is broken.",
  "error.card.invalid_card":
    "This is not a valid character card (required fields such as name or greeting are missing).",
  "error.card.png_corrupt": "This PNG file is corrupted.",
  "error.card.png_no_card": "This PNG has no character card data.",
  "error.card.charx_corrupt": "This CHARX file is corrupted.",
  "error.card.charx_no_card_json": "This CHARX file has no card.json.",
  "error.card.charx_too_large": "This CHARX file is too large when unpacked.",
  "error.chat.empty": "The chat file is empty.",
  "error.chat.invalid_json": "Line {line} of the chat file is not valid JSON.",
  "error.chat.invalid_header":
    "The header line is missing. This is not a chat exported from SillyTavern or Tavo.",
  "error.chat.invalid_message": "The message on line {line} of the chat file is malformed.",
  "error.unknown": "Something went wrong: {message}",
};
