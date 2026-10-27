import { Plugin } from "@opencode/plugin"
import { spawn, type ChildProcess } from "node:child_process"

/**
 * opencode plugin (v2): keep the Mac awake while any session is working.
 *
 * Tracks busy sessions (incl. sub-agent/child sessions) from
 * `session.execution.*` events (`session.status` on older servers). While at
 * least one session is busy/retrying, a single `caffeinate -i -w <pid>` runs
 * (prevents idle system sleep; display may still sleep). `-w` makes caffeinate exit by itself if this process dies/crashes.
 * When every session is idle again, caffeinate is killed.
 *
 * No sudo/pmset. No-op on non-darwin platforms.
 */

type KeepAwakeEvent = {
  type: string
  data?: { sessionID?: string; status?: { type?: string } }
}

// The plugin is set up once per location (project directory) and every
// instance receives events from all locations, so one caffeinate is shared
// per process. `holders` = instances that currently see a busy session.
type Shared = { child: ChildProcess | null; holders: Set<symbol> }
const shared: Shared = ((globalThis as Record<symbol, Shared | undefined>)[
  Symbol.for("yhoyoex.keep-awake")
] ??= { child: null, holders: new Set() })

function createKeepAwake(pid: number = process.pid) {
  const busy = new Set<string>()
  const token = Symbol("keep-awake")

  const start = () => {
    if (shared.child) return
    try {
      const proc = spawn("/usr/bin/caffeinate", ["-i", "-w", String(pid)], {
        detached: false,
        stdio: "ignore",
      })
      proc.on("error", () => {
        if (shared.child === proc) shared.child = null
      })
      proc.on("exit", () => {
        if (shared.child === proc) shared.child = null
      })
      shared.child = proc
    } catch {
      shared.child = null
    }
  }

  const stop = () => {
    const proc = shared.child
    shared.child = null
    if (!proc) return
    try {
      proc.kill("SIGTERM")
    } catch {
      // already gone
    }
  }

  const sync = () => {
    if (busy.size > 0) shared.holders.add(token)
    else shared.holders.delete(token)
    shared.holders.size > 0 ? start() : stop()
  }

  const handle = (event: KeepAwakeEvent) => {
    const sessionID = event.data?.sessionID
    if (!sessionID) return
    switch (event.type) {
      // opencode >= 2.1: run lifecycle via session.execution.*
      case "session.execution.started":
        busy.add(sessionID)
        break
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        busy.delete(sessionID)
        break
      // older servers
      case "session.status": {
        const status = event.data?.status?.type
        if (status === "busy" || status === "retry") busy.add(sessionID)
        else if (status === "idle") busy.delete(sessionID)
        else return
        break
      }
      case "session.idle":
      case "session.deleted":
        busy.delete(sessionID)
        break
      default:
        return
    }
    sync()
  }

  const dispose = () => {
    busy.clear()
    sync()
  }

  return { handle, dispose, isActive: () => shared.child !== null }
}

export default Plugin.define({
  id: "yhoyoex.keep-awake",
  async setup(ctx) {
    if (process.platform !== "darwin") return

    const keepAwake = createKeepAwake()
    const onExit = () => keepAwake.dispose()
    process.once("exit", onExit)

    const controller = new AbortController()
    const task = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          keepAwake.handle(event as KeepAwakeEvent)
        }
      } catch {
        // stream closed/aborted
      } finally {
        keepAwake.dispose()
      }
    })()

    return async () => {
      controller.abort()
      await task
      keepAwake.dispose()
      process.off("exit", onExit)
    }
  },
})
