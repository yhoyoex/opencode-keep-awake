import { Plugin } from "@opencode/plugin"
import { spawn, type ChildProcess } from "node:child_process"

/**
 * opencode plugin (v2): keep the Mac awake while any session is working.
 *
 * Tracks busy sessions (incl. sub-agent/child sessions) from `session.status`
 * events. While at least one session is busy/retrying, a single
 * `caffeinate -i -w <pid>` runs (prevents idle system sleep; display may still
 * sleep). `-w` makes caffeinate exit by itself if this process dies/crashes.
 * When every session is idle again, caffeinate is killed.
 *
 * No sudo/pmset. No-op on non-darwin platforms.
 */

type KeepAwakeEvent = {
  type: string
  data?: { sessionID?: string; status?: { type?: string } }
}

function createKeepAwake(pid: number = process.pid) {
  const busy = new Set<string>()
  let child: ChildProcess | null = null

  const start = () => {
    if (child) return
    try {
      const proc = spawn("/usr/bin/caffeinate", ["-i", "-w", String(pid)], {
        detached: false,
        stdio: "ignore",
      })
      proc.on("error", () => {
        if (child === proc) child = null
      })
      proc.on("exit", () => {
        if (child === proc) child = null
      })
      child = proc
    } catch {
      child = null
    }
  }

  const stop = () => {
    const proc = child
    child = null
    if (!proc) return
    try {
      proc.kill("SIGTERM")
    } catch {
      // already gone
    }
  }

  const sync = () => (busy.size > 0 ? start() : stop())

  const handle = (event: KeepAwakeEvent) => {
    const sessionID = event.data?.sessionID
    if (!sessionID) return
    switch (event.type) {
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
    stop()
  }

  return { handle, dispose, isActive: () => child !== null }
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
