---
name: line-mcp
description: Read and search the chats of the LINE account connected to the local line-mcp daemon (one-to-one, groups, OpenChat). Use to list chats, read or search messages, list changes since a sequence number, fetch attachments, announcements and profiles.
---

# line-mcp CLI

The commands talk to the line-mcp daemon on 127.0.0.1 (port 47822, or $LINE_MCP_PORT). Every result reports `stale` and the last sync times; check them before treating a result as current. Times come as `utc` and as `local`, in the daemon's time zone, which `status` reports as `time_zone`. Pass a result's cursor back unchanged to continue.

## Running the commands

The CLI is `scripts/line_cli.py` next to this SKILL.md. In every command below, replace `<skill-dir>` with the absolute path of the directory that holds this SKILL.md, and keep the double quotes, since the path may contain spaces. The commands then work from any directory.

## Tool Commands

### status

Session health, last sync times, unreconciled coverage gaps, backfill progress, archive size and time_zone, the zone every local time is given in. Check stale before treating other results as current.

```bash
uvx --from fastmcp==4.1.0 python "<skill-dir>/scripts/line_cli.py" call-tool status
```

### list_chats

Chats in the archive (one-to-one, groups, rooms, OpenChat), most recent activity first, with display names.

```bash
uvx --from fastmcp==4.1.0 python "<skill-dir>/scripts/line_cli.py" call-tool list_chats --service <value> --name <value> --limit <value> --cursor <value>
```

| Flag        | Type    | Required | Description                                                            |
| ----------- | ------- | -------- | ---------------------------------------------------------------------- |
| `--service` | string  | no       | talk: one-to-one chats, groups and rooms; square: OpenChat             |
| `--name`    | string  | no       | Only chats whose display name contains this text                       |
| `--limit`   | integer | no       | Items per page, 1 to 200; default 50                                   |
| `--cursor`  | string  | no       | Continuation from a previous result of this tool with the same filters |

### read_messages

Messages of one chat or thread, oldest first within a page. Without a cursor: the newest page. older_cursor and newer_cursor page from there; around_message_id centres a page on one message. Unsent messages appear without text.

```bash
uvx --from fastmcp==4.1.0 python "<skill-dir>/scripts/line_cli.py" call-tool read_messages --service <value> --chat-id <value> --thread-id <value> --around-message-id <value> --limit <value> --cursor <value>
```

| Flag                  | Type    | Required | Description                                                            |
| --------------------- | ------- | -------- | ---------------------------------------------------------------------- |
| `--service`           | string  | yes      | talk: one-to-one chats, groups and rooms; square: OpenChat             |
| `--chat-id`           | string  | yes      | Chat ID from list_chats                                                |
| `--thread-id`         | string  | no       | Only this Square thread                                                |
| `--around-message-id` | string  | no       | Centre the page on this message                                        |
| `--limit`             | integer | no       | Items per page, 1 to 200; default 50                                   |
| `--cursor`            | string  | no       | Continuation from a previous result of this tool with the same filters |

### search_messages

Search message text, newest first. Queries of 3 or more characters use the trigram index; 1 or 2 characters scan one chat, or the 20,000 most recent messages when no chat is given.

```bash
uvx --from fastmcp==4.1.0 python "<skill-dir>/scripts/line_cli.py" call-tool search_messages --query <value> --service <value> --chat-id <value> --limit <value> --cursor <value>
```

| Flag        | Type    | Required | Description                                                            |
| ----------- | ------- | -------- | ---------------------------------------------------------------------- |
| `--query`   | string  | yes      | Text to find, for example 晚餐                                         |
| `--service` | string  | no       | talk: one-to-one chats, groups and rooms; square: OpenChat             |
| `--chat-id` | string  | no       | Chat ID from list_chats                                                |
| `--limit`   | integer | no       | Items per page, 1 to 200; default 50                                   |
| `--cursor`  | string  | no       | Continuation from a previous result of this tool with the same filters |

### list_changes

Every message inserted or changed (edit, unsend, late decryption) after after_seq, in seq order. Continue with next_after_seq. A message changed again reappears with its new seq; nothing is skipped.

```bash
uvx --from fastmcp==4.1.0 python "<skill-dir>/scripts/line_cli.py" call-tool list_changes --after-seq <value> --limit <value>
```

| Flag          | Type    | Required | Description                                 |
| ------------- | ------- | -------- | ------------------------------------------- |
| `--after-seq` | integer | no       | Return changes with a larger seq; default 0 |
| `--limit`     | integer | no       | Items per page, 1 to 200; default 50        |

### get_attachment

Attachment of an image, video, audio or file message: metadata, or with download true the file saved to a private cache and its local path. Refused for unsent messages.

```bash
uvx --from fastmcp==4.1.0 python "<skill-dir>/scripts/line_cli.py" call-tool get_attachment --service <value> --chat-id <value> --message-id <value> --download
```

| Flag           | Type    | Required | Description                                                |
| -------------- | ------- | -------- | ---------------------------------------------------------- |
| `--service`    | string  | yes      | talk: one-to-one chats, groups and rooms; square: OpenChat |
| `--chat-id`    | string  | yes      | Chat ID from list_chats                                    |
| `--message-id` | string  | yes      | LINE message ID (decimal string)                           |
| `--download`   | boolean | no       | Download the file and return its local path                |

### get_announcements

Pinned announcements of a group, room or OpenChat chat, asked from LINE. One-to-one chats have none.

```bash
uvx --from fastmcp==4.1.0 python "<skill-dir>/scripts/line_cli.py" call-tool get_announcements --service <value> --chat-id <value>
```

| Flag        | Type   | Required | Description                                                |
| ----------- | ------ | -------- | ---------------------------------------------------------- |
| `--service` | string | yes      | talk: one-to-one chats, groups and rooms; square: OpenChat |
| `--chat-id` | string | yes      | Chat ID from list_chats                                    |

### get_profile

Profile from LINE: without id the connected LINE account; a Talk user MID; or with service square an OpenChat member ID (starting with p).

```bash
uvx --from fastmcp==4.1.0 python "<skill-dir>/scripts/line_cli.py" call-tool get_profile --service <value> --id <value>
```

| Flag        | Type   | Required | Description                                                           |
| ----------- | ------ | -------- | --------------------------------------------------------------------- |
| `--service` | string | no       | Default talk                                                          |
| `--id`      | string | no       | User MID (Talk) or member ID (Square); omit for the connected account |

## Utility Commands

```bash
uvx --from fastmcp==4.1.0 python "<skill-dir>/scripts/line_cli.py" list-tools
uvx --from fastmcp==4.1.0 python "<skill-dir>/scripts/line_cli.py" list-resources
uvx --from fastmcp==4.1.0 python "<skill-dir>/scripts/line_cli.py" read-resource <uri>
uvx --from fastmcp==4.1.0 python "<skill-dir>/scripts/line_cli.py" list-prompts
uvx --from fastmcp==4.1.0 python "<skill-dir>/scripts/line_cli.py" get-prompt <name> [key=value ...]
```
