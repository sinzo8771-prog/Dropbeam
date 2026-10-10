import { useEffect, useRef } from "preact/hooks";
import type { Settings, Theme } from "../core/platform/storage";
import { LANGUAGES, type Translate } from "../core/platform/i18n";

/**
 * FR-41 settings sheet. A native `<dialog>` styled as a bottom sheet
 * (PRD 10.6): focus trapping, Escape and the top layer come from the
 * platform, so nothing here re-implements modal behaviour.
 *
 * The sheet is a view over the `SettingsStore` only — it never touches
 * the connection or the transfer engine. Theme, language and the
 * motion/stay-awake switches are applied by the app shell; this
 * component's job is to render current values and emit patches
 * (FR-40: only the allowlisted keys ever exist here).
 */

export type SettingsSheetProps = {
  open: boolean;
  settings: Settings;
  t: Translate;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
};

/** PRD 10.6: real radios so the segmented controls keep keyboard support. */
const THEMES = [
  { value: "system", key: "settings.theme.system" },
  { value: "light", key: "settings.theme.light" },
  { value: "dark", key: "settings.theme.dark" },
] as const;

const LANG_KEYS = {
  en: "settings.language.en",
  hi: "settings.language.hi",
} as const;

/** PRD 10.1 #7 lists wake lock among the settings; it is opt-in per browser. */
function wakeLockSupported(): boolean {
  return typeof navigator !== "undefined" && "wakeLock" in navigator;
}

function Segmented({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <fieldset class="settings-group">
      <legend>{legend}</legend>
      <div class="segments">
        {options.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SwitchRow({
  label,
  help,
  checked,
  stateOn,
  stateOff,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  stateOn: string;
  stateOff: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div class="settings-group">
      {/* The visible state text is the sighted-user signal; assistive tech
          reads the switch's own checked state (PRD 10.4: never colour alone). */}
      <label class="switch">
        <span class="switch-label">{label}</span>
        <span class="switch-control">
          <span class="switch-state">{checked ? stateOn : stateOff}</span>
          <input
            type="checkbox"
            role="switch"
            aria-label={label}
            checked={checked}
            onChange={(event) => onChange(event.currentTarget.checked)}
          />
        </span>
      </label>
      {help ? <p class="hint">{help}</p> : null}
    </div>
  );
}

export function SettingsSheet({ open, settings, t, onChange, onClose }: SettingsSheetProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof el.showModal === "function") {
      // Real browsers: the top layer, focus trap and Escape come free.
      if (open && !el.open) el.showModal();
      if (!open && el.open) el.close();
      return;
    }
    // Environments without showModal (jsdom) would otherwise render a dialog
    // that silently never opens; keep the open attribute in sync instead.
    el.open = open;
  }, [open]);

  const theme = settings.theme as Theme;

  return (
    <dialog
      class="sheet settings"
      ref={ref}
      aria-labelledby="settings-title"
      onCancel={(event) => {
        // Escape must route through the same handler as the Close button so
        // the open state has exactly one owner.
        event.preventDefault();
        onClose();
      }}
    >
      <h2 class="settings-title" id="settings-title">
        {t("settings.title")}
      </h2>

      <Segmented
        legend={t("settings.theme")}
        name="settings-theme"
        value={theme}
        options={THEMES.map((entry) => ({ value: entry.value, label: t(entry.key) }))}
        onChange={(value) => onChange({ theme: value as Theme })}
      />

      <Segmented
        legend={t("settings.language")}
        name="settings-language"
        value={settings.language}
        options={LANGUAGES.map((lang) => ({ value: lang, label: t(LANG_KEYS[lang]) }))}
        onChange={(value) => onChange({ language: value as Settings["language"] })}
      />

      <SwitchRow
        label={t("settings.autoAccept")}
        help={t("settings.autoAcceptHelp")}
        checked={settings.autoAccept}
        stateOn={t("settings.state.on")}
        stateOff={t("settings.state.off")}
        onChange={(checked) => onChange({ autoAccept: checked })}
      />

      <SwitchRow
        label={t("settings.stun")}
        help={t("settings.stunHelp")}
        checked={settings.ice.mode === "stun"}
        stateOn={t("settings.state.on")}
        stateOff={t("settings.state.off")}
        onChange={(checked) =>
          onChange({
            ice: {
              ...settings.ice,
              // PRD 8.3: local-only stays the default; STUN is strictly opt-in.
              mode: checked ? "stun" : "local",
            },
          })
        }
      />

      {wakeLockSupported() ? (
        <SwitchRow
          label={t("settings.wakeLock")}
          checked={settings.wakeLock}
          stateOn={t("settings.state.on")}
          stateOff={t("settings.state.off")}
          onChange={(checked) => onChange({ wakeLock: checked })}
        />
      ) : null}

      <SwitchRow
        label={t("settings.reduceMotion")}
        checked={settings.reduceMotion}
        stateOn={t("settings.state.on")}
        stateOff={t("settings.state.off")}
        onChange={(checked) => onChange({ reduceMotion: checked })}
      />

      <div class="settings-group">
        <label class="settings-field-label" for="settings-device-name">
          {t("settings.deviceName")}
        </label>
        {/* FR-42: display-only, trimmed and length-capped before it is ever
            encoded into a handshake; never persisted (storage.ts). */}
        <input
          id="settings-device-name"
          type="text"
          maxLength={64}
          autoComplete="off"
          value={settings.deviceName}
          placeholder={t("connect.unknownPeer")}
          // Live, like the note field (TransferPanel): the label feeds the
          // next pairing attempt, so it should be current as it is typed.
          onInput={(event) => onChange({ deviceName: event.currentTarget.value })}
        />
        <p class="hint">{t("settings.deviceNameHelp")}</p>
      </div>

      <div class="settings-actions">
        <button type="button" class="btn btn-primary" onClick={onClose}>
          {t("action.close")}
        </button>
      </div>
    </dialog>
  );
}
