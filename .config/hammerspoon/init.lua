-- Per-app key remaps: while an app is frontmost, a chord it doesn't use
-- becomes one it does.
local remaps = {
  ["com.microsoft.teams2"] = {
    -- accept-audio-call -> toggle mute
    { from = { { "cmd", "shift" }, "a" }, to = { { "cmd", "shift" }, "m" } },
    -- accept-video-call -> toggle video
    { from = { { "cmd", "shift" }, "v" }, to = { { "cmd", "shift" }, "o" } },
    -- Zoom muscle memory -> start/stop screen share
    { from = { { "cmd", "shift" }, "s" }, to = { { "cmd", "shift" }, "e" } },
  },
}

-- Bind every remap up front, disabled; the watcher below turns on the set
-- belonging to whichever app just came forward.
local hotkeys = {}
for bundleID, entries in pairs(remaps) do
  hotkeys[bundleID] = hs.fnutils.map(entries, function(entry)
    local mods, key = table.unpack(entry.to)
    local send = function()
      hs.eventtap.keyStroke(mods, key)
    end
    return hs.hotkey.new(entry.from[1], entry.from[2], send, nil, send)
  end)
end

local function enableFor(bundleID)
  for id, keys in pairs(hotkeys) do
    for _, hotkey in ipairs(keys) do
      if id == bundleID then hotkey:enable() else hotkey:disable() end
    end
  end
end

appWatcher = hs.application.watcher.new(function(_, event, app)
  if event == hs.application.watcher.activated then
    enableFor(app:bundleID())
  end
end)
appWatcher:start()

local front = hs.application.frontmostApplication()
if front then enableFor(front:bundleID()) end

hs.alert.show("Hammerspoon config loaded")
