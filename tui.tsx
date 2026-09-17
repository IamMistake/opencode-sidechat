import type { SessionMessageInfo } from "@opencode/client"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { TextareaRenderable } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"

const PANEL = "local.mini-session.sidechat"
const REGISTRY_KEY = "sidechat-registry-memory"
const SIDECHAT_INSTRUCTION =
  "You are in a read-only side chat. Investigate and explain, but never edit files, run commands, or perform side effects."

type Delivery = "queue" | "steer"
type SidechatRecord = {
  parentSessionID: string
  sideSessionID: string
  title: string
  seedMessageCount: number
  createdAt: number
  lastOpenedAt: number
  delivery: Delivery
}
type SidechatRegistry = { records: SidechatRecord[] }

const READ_ONLY_PERMISSIONS = [
  { action: "*", resource: "*", effect: "deny" as const },
  { action: "read", resource: "*", effect: "allow" as const },
  { action: "glob", resource: "*", effect: "allow" as const },
  { action: "grep", resource: "*", effect: "allow" as const },
  { action: "webfetch", resource: "*", effect: "allow" as const },
  { action: "websearch", resource: "*", effect: "allow" as const },
]

export default Plugin.define({
  id: "local.mini-session",
  setup(ctx) {
    const [registry, updateRegistry] = ctx.storage.memory(REGISTRY_KEY, {
      initial: { records: [] } as SidechatRegistry,
    })
    const updateRecords = async (mutation: (draft: SidechatRecord[]) => void) =>
      updateRegistry((draft) => mutation(draft.records))
    const currentSessionID = () => {
      const route = ctx.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    const getRecord = (parentSessionID: string) =>
      registry.records.find((item) => item.parentSessionID === parentSessionID)

    const sessionExists = async (sessionID: string) => {
      try {
        await ctx.client.session.get({ sessionID })
        return true
      } catch {
        return false
      }
    }

    const openSidechat = async (input?: string, forceNew = false) => {
      const parentSessionID = currentSessionID()
      if (!parentSessionID) {
        ctx.ui.toast.show({ variant: "warning", message: "Open a session before starting a side chat." })
        return
      }

      try {
        let existing = forceNew ? undefined : getRecord(parentSessionID)
        if (existing && !(await sessionExists(existing.sideSessionID))) {
          await updateRecords((draft) => {
            const index = draft.findIndex((item) => item.sideSessionID === existing?.sideSessionID)
            if (index >= 0) draft.splice(index, 1)
          })
          existing = undefined
        }
        if (existing) {
          ctx.ui.panel.open(PANEL)
          if (input?.trim()) {
            await sendPrompt(existing.sideSessionID, input.trim(), existing.delivery)
          }
          return
        }

        const parent = await ctx.client.session.get({ sessionID: parentSessionID })
        const child = await ctx.client.session.fork({ sessionID: parentSessionID })

        if (parent.model) {
          await ctx.client.session.switchModel({ sessionID: child.id, model: parent.model })
        }
        if (parent.agent) {
          await ctx.client.session.switchAgent({ sessionID: child.id, agent: parent.agent })
        }

        await ctx.client.session.update({
          sessionID: child.id,
          title: `Side chat · ${parent.title}`,
          permissions: READ_ONLY_PERMISSIONS,
        })
        const record: SidechatRecord = {
          parentSessionID,
          sideSessionID: child.id,
          title: `Side chat · ${parent.title}`,
          seedMessageCount: 0,
          createdAt: Date.now(),
          lastOpenedAt: Date.now(),
          delivery: "queue",
        }
        await updateRecords((draft) => {
          for (let index = draft.length - 1; index >= 0; index -= 1) {
            if (draft[index].parentSessionID === parentSessionID) draft.splice(index, 1)
          }
          draft.push(record)
        })
        ctx.ui.panel.open(PANEL)
        if (input?.trim()) await sendPrompt(child.id, input.trim(), record.delivery)
      } catch (error) {
        ctx.ui.toast.show({ variant: "error", title: "Side chat failed", message: errorMessage(error) })
      }
    }

    const sendPrompt = async (sessionID: string, text: string, delivery: Delivery) => {
      try {
        await ctx.client.session.prompt({
          sessionID,
          text: `${SIDECHAT_INSTRUCTION}\n\n${text}`,
          metadata: { sidechat: true, displayText: text },
          delivery,
        })
        ctx.data.session.message.invalidate(sessionID)
      } catch (error) {
        ctx.ui.toast.show({ variant: "error", title: "Side chat prompt failed", message: errorMessage(error) })
      }
    }

    const discardSidechat = async (sessionID: string) => {
      try {
        await ctx.client.session.interrupt({ sessionID })
      } catch {
        // It may already be idle.
      }
      try {
        await ctx.client.session.remove({ sessionID })
      } catch {
        // A temporary child may already have been deleted during shutdown.
      }
      await updateRecords((draft) => {
        for (let index = draft.length - 1; index >= 0; index -= 1) {
          if (draft[index].sideSessionID === sessionID) draft.splice(index, 1)
        }
      })
      ctx.ui.panel.close()
    }

    const handoff = async (record: SidechatRecord, scope: "latest" | "all") => {
      const parentSessionID = record.parentSessionID
      const messages = (await ctx.client.message.list({
        sessionID: record.sideSessionID,
        order: "desc",
        limit: 200,
      })).data.toReversed()
      const sideMessages = sidechatMessages(messages, record)
      const transcript = (scope === "latest" ? latestTurn(sideMessages) : sideMessages)
        .map(formatMessage)
        .filter(Boolean)
        .join("\n\n")
      if (!transcript) {
        ctx.ui.toast.show({ variant: "info", message: "There is no side-chat answer to send yet." })
        return false
      }
      await ctx.client.session.prompt({
        sessionID: parentSessionID,
        text: [
          "The following comes from a read-only side conversation branched from this session.",
          "Treat it as supplemental context, not as new requirements unless explicitly stated.",
          "Incorporate relevant conclusions and continue the main task.",
          "",
          `<sidechat>\n${transcript}\n</sidechat>`,
        ].join("\n"),
        delivery: "queue",
      })
      ctx.ui.toast.show({ variant: "success", message: "Side-chat context queued in the main session." })
      return true
    }

    const handoffAndClose = async (record: SidechatRecord) => {
      if (await handoff(record, "all")) await discardSidechat(record.sideSessionID)
    }

    const unregisterPanel = ctx.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <SidechatPanel
            panel={panel}
            getRecord={getRecord}
            openSidechat={openSidechat}
            sendPrompt={sendPrompt}
            updateRegistry={updateRecords}
            discardSidechat={discardSidechat}
            handoff={handoff}
            handoffAndClose={handoffAndClose}
          />
        </Show>
      ),
    })

    const unregisterCommands = ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => ({
          mode: "global",
          priority: 20,
          commands: [
            {
              id: "mini-session.open",
              title: "Open side chat",
              description: "Open a parallel contextual conversation",
              group: "Side chat",
              bind: "alt+b",
              palette: true,
              slash: { name: "side", arguments: true },
              enabled: () => Boolean(currentSessionID()),
              run: (input) => openSidechat(input),
            },
            {
              id: "mini-session.focus-main",
              title: "Focus main chat",
              description: "Close the side panel without discarding its temporary chat",
              group: "Side chat",
              bind: "<leader>left",
              enabled: () => Boolean(currentSessionID()),
              run: () => ctx.ui.panel.close(),
            },
            {
              id: "mini-session.focus-side",
              title: "Focus side chat",
              description: "Open the temporary side-chat panel",
              group: "Side chat",
              bind: "<leader>right",
              enabled: () => Boolean(currentSessionID()),
              run: () => openSidechat(),
            },
            {
              id: "mini-session.open-alias",
              title: "Open mini session",
              group: "Side chat",
              palette: true,
              slash: { name: "mini", arguments: true },
              enabled: () => Boolean(currentSessionID()),
              run: (input) => openSidechat(input),
            },
            {
              id: "mini-session.new",
              title: "New side chat",
              group: "Side chat",
              palette: true,
              slash: { name: "side-new", arguments: true },
              enabled: () => Boolean(currentSessionID()),
              run: (input) => openSidechat(input, true),
            },
            {
              id: "mini-session.send-main",
              title: "Send side-chat answer to main session",
              group: "Side chat",
              palette: true,
              slash: { name: "side-send", arguments: true },
              enabled: () => Boolean(ctx.ui.panel.current()),
              run: async (input) => {
                const panel = ctx.ui.panel.current()
                if (!panel) return
                const record = registry.records.find((item) => item.parentSessionID === panel.sessionID)
                if (!record) return
                await handoff(record, input?.trim() === "all" ? "all" : "latest")
              },
            },
            {
              id: "mini-session.discard",
              title: "Discard side chat",
              group: "Side chat",
              palette: true,
              slash: { name: "side-discard" },
              enabled: () => Boolean(ctx.ui.panel.current()),
              run: async () => {
                const panel = ctx.ui.panel.current()
                const record = panel && registry.records.find((item) => item.parentSessionID === panel.sessionID)
                if (record) await discardSidechat(record.sideSessionID)
              },
            },
          ],
          bindings: ["mini-session.open"],
        }))
        return null
      },
    })

    return () => {
      for (const record of registry.records) {
        void ctx.client.session.remove({ sessionID: record.sideSessionID }).catch(() => undefined)
      }
      unregisterPanel()
      unregisterCommands()
    }
  },
})

function SidechatPanel(props: {
  panel: PanelInput
  getRecord: (parentSessionID: string) => SidechatRecord | undefined
  openSidechat: (input?: string, forceNew?: boolean) => Promise<void>
  sendPrompt: (sessionID: string, text: string, delivery: Delivery) => Promise<void>
  updateRegistry: (mutation: (draft: SidechatRecord[]) => void) => Promise<void>
  discardSidechat: (sessionID: string) => Promise<void>
  handoff: (record: SidechatRecord, scope: "latest" | "all") => Promise<boolean>
  handoffAndClose: (record: SidechatRecord) => Promise<void>
}) {
  const context = usePlugin()
  const [delivery, setDelivery] = createSignal<Delivery>(
    props.getRecord(props.panel.sessionID)?.delivery ?? "queue",
  )
  const [draft, setDraft] = createSignal("")
  const [textareaTarget, setTextareaTarget] = createSignal<TextareaRenderable>()
  const [loadedMessages, setLoadedMessages] = createSignal<SessionMessageInfo[]>([])
  const [loadError, setLoadError] = createSignal<string>()
  let textarea: TextareaRenderable | undefined
  const record = createMemo(() => props.getRecord(props.panel.sessionID))
  const messages = createMemo(() => {
    const current = record()
    if (!current) return [] as SessionMessageInfo[]
    return sidechatMessages(loadedMessages(), current)
  })
  const status = createMemo(() => {
    const current = record()
    return current ? context.data.session.status(current.sideSessionID) : "idle"
  })

  let refreshVersion = 0
  const refreshMessages = async () => {
    const current = record()
    if (!current) return
    const version = ++refreshVersion
    try {
      const response = await context.client.message.list({
        sessionID: current.sideSessionID,
        order: "desc",
        limit: 200,
      })
      if (version === refreshVersion) {
        setLoadedMessages(response.data.toReversed())
        setLoadError(undefined)
      }
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }

  const refreshForSidechat = (event: { data: { sessionID: string } }) => {
    if (event.data.sessionID === record()?.sideSessionID) void refreshMessages()
  }
  const stopInbox = context.data.on("session.inbox.delivered", refreshForSidechat)
  const stopText = context.data.on("session.text.ended", refreshForSidechat)
  const stopSuccess = context.data.on("session.execution.succeeded", refreshForSidechat)
  const stopFailure = context.data.on("session.execution.failed", refreshForSidechat)
  const stopInterrupted = context.data.on("session.execution.interrupted", refreshForSidechat)
  onCleanup(() => {
    stopInbox()
    stopText()
    stopSuccess()
    stopFailure()
    stopInterrupted()
  })

  const submit = async () => {
    const text = (textarea?.plainText ?? draft()).trim()
    const current = record()
    if (!text || !current) return
    setDraft("")
    textarea?.clear()
    const selected = delivery()
    await props.updateRegistry((items) => {
      const found = items.find((item) => item.sideSessionID === current.sideSessionID)
      if (found) found.delivery = selected
    })
    await props.sendPrompt(current.sideSessionID, text, selected)
    await refreshMessages()
  }

  const focusComposer = () => {
    props.panel.focus()
    queueMicrotask(() => {
      if (!textarea || textarea.isDestroyed) return
      textarea.focus()
    })
  }

  onMount(() => {
    void refreshMessages()
    setTimeout(focusComposer, 1)
  })
  createEffect(() => {
    if (props.panel.focused) focusComposer()
  })

  context.keymap.layer(() => ({
    target: () => textareaTarget(),
    priority: 10,
    commands: [
      {
        title: "Close side chat",
        bind: "escape",
        run: props.panel.close,
      },
      {
        title: "Toggle side-chat delivery",
        bind: "ctrl+q",
        run: () => setDelivery((current) => (current === "queue" ? "steer" : "queue")),
      },
      {
        title: "Toggle side-chat fullscreen",
        bind: "alt+f",
        run: props.panel.toggleFullscreen,
      },
      {
        title: "Send side chat to main and close",
        bind: "alt+enter",
        run: async () => {
          const current = record()
          if (current) await props.handoffAndClose(current)
        },
      },
    ],
  }))

  return (
    <box flexDirection="column" width="100%" height="100%" padding={1}>
      <text height={2} fg={context.theme.text.default} wrapMode="word">
        {"◇ Side chat\nCtrl+X Left main · Ctrl+X Right side · Alt+Enter send + close"}
      </text>

      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingRight={1}>
        <Show when={loadError()}>{(message) => <text fg={context.theme.error}>{`Could not load transcript: ${message()}`}</text>}</Show>
        <For each={messages()}>{(message) => <MessageView message={message} theme={context.theme} />}</For>
        <Show when={status() === "running"}>
          <text fg={context.theme.textMuted}>Thinking…</text>
        </Show>
      </scrollbox>

      <text fg="#e0af68" wrapMode="word">
        {`Delivery: ${delivery()} · /side-send latest|all`}
      </text>

      <textarea
        ref={(value: TextareaRenderable) => {
          textarea = value
          setTextareaTarget(value)
        }}
        width="100%"
        height={3}
        wrapMode="word"
        backgroundColor="#20283a"
        focusedBackgroundColor="#2b3650"
        textColor="#dce6ff"
        focusedTextColor="#ffffff"
        cursorColor="#7aa2f7"
        placeholderColor="#8290ad"
        placeholder="Ask the side chat…"
        onContentChange={() => setDraft(textarea?.plainText ?? "")}
        onSubmit={submit}
      />

      <text fg="#7aa2f7" wrapMode="word">Enter send · Shift+Enter newline · Esc keeps this temporary chat</text>
    </box>
  )
}

function MessageView(props: { message: SessionMessageInfo; theme: ReturnType<typeof usePlugin>["theme"] }) {
  const text = formatMessage(props.message)
  if (!text) return null
  const isUser = props.message.type === "user"
  if (isUser) {
    return (
      <box flexDirection="column" paddingBottom={1}>
        <text fg={props.theme.info}>◆ You</text>
        <text fg="#7dcfff" wrapMode="word">{text}</text>
      </box>
    )
  }

  if (props.message.type !== "assistant") return null
  return (
    <box flexDirection="column" paddingBottom={1}>
      <text fg="#9ece6a">● Side chat</text>
      <For each={props.message.content}>
        {(part) =>
          part.type === "text" ? (
            <text fg="#c0caf5" wrapMode="word">{part.text}</text>
          ) : part.type === "tool" ? (
            <text fg="#e0af68">{`⚙ ${part.name}`}</text>
          ) : null
        }
      </For>
      <Show when={props.message.error}>
        {(error) => <text fg="#f7768e">{`Error: ${errorMessage(error())}`}</text>}
      </Show>
    </box>
  )
}

function formatMessage(message: SessionMessageInfo): string | undefined {
  if (message.type === "user") {
    const displayText = message.metadata?.displayText
    if (typeof displayText === "string") return displayText
    const prefix = `${SIDECHAT_INSTRUCTION}\n\n`
    return message.text.startsWith(prefix) ? message.text.slice(prefix.length) : message.text
  }
  if (message.type !== "assistant") return undefined
  return message.content
    .map((part) => (part.type === "text" ? part.text : part.type === "tool" ? `[tool: ${part.name}]` : ""))
    .filter(Boolean)
    .join("\n")
    .trim()
}

function latestTurn(messages: readonly SessionMessageInfo[]) {
  let userIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].type === "user") {
      userIndex = index
      break
    }
  }
  return userIndex < 0 ? messages.slice(-1) : messages.slice(userIndex)
}

function sidechatMessages(messages: readonly SessionMessageInfo[], record: SidechatRecord) {
  const firstSidechatTurn = messages.findIndex(isSidechatUserMessage)
  const candidates = firstSidechatTurn >= 0
    ? messages.slice(firstSidechatTurn)
    : messages.filter((message) => message.time.created >= record.createdAt)
  return candidates.filter((message) => message.type === "user" || message.type === "assistant")
}

function isSidechatUserMessage(message: SessionMessageInfo) {
  return message.type === "user" &&
    (message.metadata?.sidechat === true || message.text.startsWith(`${SIDECHAT_INSTRUCTION}\n\n`))
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}
