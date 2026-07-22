import { useEffect, useMemo, useRef } from "react";
import { listModels } from "../extract/anthropic";

/** Connection settings for the user's own LLM endpoint (BYOK). */
export interface AppSettings {
  apiKey: string;
  model: string;
  baseUrl: string;
  /** Explicit opt-in: persist the API key to localStorage. */
  persistKey: boolean;
}

export const DEFAULT_BASE_URL = "https://api.anthropic.com";

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: "",
  model: "",
  baseUrl: DEFAULT_BASE_URL,
  persistKey: false,
};

const SETTINGS_KEY = "timezero.settings";

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_SETTINGS };
    const p = parsed as Partial<AppSettings>;
    return {
      apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
      model: typeof p.model === "string" ? p.model : "",
      baseUrl: typeof p.baseUrl === "string" && p.baseUrl ? p.baseUrl : DEFAULT_BASE_URL,
      persistKey: p.persistKey === true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persists model/baseUrl always; the API key only with explicit opt-in. */
export function saveSettings(s: AppSettings): void {
  try {
    const toStore: Partial<AppSettings> = {
      model: s.model,
      baseUrl: s.baseUrl,
      persistKey: s.persistKey,
    };
    if (s.persistKey) toStore.apiKey = s.apiKey;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(toStore));
  } catch {
    /* storage unavailable — settings stay in memory */
  }
}

interface SettingsModalProps {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
  onClose: () => void;
}

export default function SettingsModal({ settings, onChange, onClose }: SettingsModalProps) {
  const models = useMemo(() => {
    try {
      return listModels();
    } catch {
      return [];
    }
  }, []);
  const keyInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    keyInputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Adopt the first known model when none is chosen yet.
  useEffect(() => {
    if (!settings.model && models.length > 0) {
      onChange({ ...settings, model: models[0].id });
    }
    // Intentionally runs once with the then-current settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models]);

  const modelInList = models.some((m) => m.id === settings.model);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="settings-title" className="modal">
        <h2 className="modal-title" id="settings-title">
          Settings
        </h2>
        <p className="card-sub">
          Your key is used directly from this browser to call the endpoint below. It is kept in
          memory only, unless you opt in to storing it.
        </p>

        <div className="field">
          <label className="field-label" htmlFor="set-key">
            Anthropic API key
          </label>
          <input
            id="set-key"
            ref={keyInputRef}
            className="control control-wide"
            type="password"
            autoComplete="off"
            placeholder="sk-ant-…"
            value={settings.apiKey}
            onChange={(e) => onChange({ ...settings, apiKey: e.target.value })}
          />
          <label className="check" style={{ marginTop: "0.4rem" }}>
            <input
              type="checkbox"
              checked={settings.persistKey}
              onChange={(e) => onChange({ ...settings, persistKey: e.target.checked })}
            />
            Remember this key in this browser
          </label>
          {settings.persistKey && (
            <p className="key-warning">
              The key will be stored unencrypted in this browser&rsquo;s localStorage. Anyone with
              access to this browser profile can read it. Uncheck to keep it in memory for this
              session only.
            </p>
          )}
        </div>

        <div className="field">
          <label className="field-label" htmlFor="set-model">
            Model
          </label>
          {models.length > 0 ? (
            <select
              id="set-model"
              className="control control-wide"
              value={settings.model}
              onChange={(e) => onChange({ ...settings, model: e.target.value })}
            >
              {!modelInList && settings.model && (
                <option value={settings.model}>{settings.model}</option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="set-model"
              className="control control-wide"
              type="text"
              placeholder="Model id"
              value={settings.model}
              onChange={(e) => onChange({ ...settings, model: e.target.value })}
            />
          )}
          <span className="field-hint">
            {models.length === 0
              ? "Model list unavailable — enter a model id."
              : "Model used for spec extraction."}
          </span>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="set-baseurl">
            API base URL
          </label>
          <input
            id="set-baseurl"
            className="control control-wide"
            type="url"
            placeholder={DEFAULT_BASE_URL}
            value={settings.baseUrl}
            onChange={(e) => onChange({ ...settings, baseUrl: e.target.value })}
          />
          <span className="field-hint">
            Point this at a compatible proxy if your organization requires one. Documents are sent
            only to this endpoint.
          </span>
        </div>

        <div className="modal-foot">
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => onChange({ ...settings, baseUrl: DEFAULT_BASE_URL })}
          >
            Reset base URL
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
