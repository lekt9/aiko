/**
 * App auto-update row for Settings → About.
 */
import { useState } from "react";
import { useUpdaterContext } from "@/hooks/UpdaterProvider";
import * as api from "@/lib/api";
import type { MessageKey } from "@/i18n";

export function AboutUpdateRow({
  t,
}: {
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  // Single authority: useUpdater (plugin path or GitHub fallback).
  const {
    status,
    channelInfo,
    checkForUpdate,
    installAndRelaunch,
    githubReleasesUrl,
  } = useUpdaterContext();
  const [openError, setOpenError] = useState<string | null>(null);

  const openRelease = async (url: string) => {
    try {
      setOpenError(null);
      await api.openExternalUrl(url);
    } catch (e) {
      setOpenError(String(e));
    }
  };

  const statusText = (() => {
    switch (status.state) {
      case "checking":
        return t("settings.autoUpdateChecking");
      case "up-to-date":
        return status.version
          ? t("settings.checkUpdateLatest", { version: status.version })
          : t("settings.autoUpdateUpToDate");
      case "available":
        return t("settings.autoUpdateAvailable", { version: status.version });
      case "downloading":
        return t("settings.autoUpdateDownloading");
      case "ready":
        return t("settings.autoUpdateReady");
      case "installing":
        return t("settings.autoUpdateInstalling");
      case "restarting":
        return t("settings.autoUpdateRestarting");
      case "manual-required":
        return t("settings.autoUpdateManualRequired", {
          version: status.version,
        });
      case "error":
        return null;
      default:
        return null;
    }
  })();

  const busy =
    status.state === "checking" ||
    status.state === "downloading" ||
    status.state === "installing" ||
    status.state === "restarting";

  // Only show install when download finished (ready), never on available.
  // After install, restart runs automatically (no second click).
  const showInstall = status.state === "ready";
  const showInstalling =
    status.state === "installing" || status.state === "restarting";
  const showOpenRelease = status.state === "manual-required";
  const releaseUrl =
    status.state === "manual-required" ? status.releaseUrl : githubReleasesUrl;
  const downloadUrl =
    status.state === "manual-required" ? status.downloadUrl : null;
  const assetNames =
    status.state === "manual-required" ? status.assetNames : undefined;
  const highlight =
    status.state === "available" ||
    status.state === "ready" ||
    status.state === "downloading" ||
    status.state === "manual-required";

  return (
    <div className="settings-row settings-row--stack">
      <div className="settings-row__text">
        <div className="settings-row__label">{t("settings.checkUpdate")}</div>
        <div className="settings-row__desc">{t("settings.checkUpdateDesc")}</div>
        <div className="settings-row__hint" data-updater-channel={channelInfo.channel}>
          {channelInfo.channel === "silent"
            ? t("settings.autoUpdateChannelSilent")
            : t("settings.autoUpdateChannelManual")}
          {channelInfo.endpoint
            ? ` · ${channelInfo.endpoint.replace(/^https:\/\//, "")}`
            : ""}
        </div>
      </div>
      <div className="settings-about-update">
        <div className="settings-about-update__actions">
          <button
            type="button"
            className="btn btn--solid"
            disabled={busy}
            onClick={() => void checkForUpdate()}
          >
            {busy
              ? t("settings.checkUpdateChecking")
              : t("settings.checkUpdate")}
          </button>
          {showInstalling ? (
            <button type="button" className="btn btn--solid" disabled>
              {status.state === "restarting"
                ? t("settings.autoUpdateRestarting")
                : t("settings.autoUpdateInstalling")}
            </button>
          ) : showInstall ? (
            <button
              type="button"
              className="btn btn--solid"
              disabled={busy}
              onClick={() => void installAndRelaunch()}
            >
              {t("settings.autoUpdateInstall")}
            </button>
          ) : null}
          {showOpenRelease && downloadUrl ? (
            <button
              type="button"
              className="btn btn--solid"
              onClick={() => void openRelease(downloadUrl)}
            >
              {t("settings.checkUpdateDownload")}
            </button>
          ) : null}
          {showOpenRelease ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void openRelease(releaseUrl)}
            >
              {t("settings.checkUpdateOpen")}
            </button>
          ) : null}
        </div>
        {statusText ? (
          <div
            className={
              "settings-about-update__status" + (highlight ? " is-available" : "")
            }
            role="status"
          >
            {statusText}
          </div>
        ) : null}
        {status.state === "error" ? (
          <div className="settings-about-update__err" role="alert">
            {t("settings.autoUpdateError", { error: status.message })}
          </div>
        ) : null}
        {openError ? (
          <div className="settings-about-update__err" role="alert">
            {t("settings.checkUpdateFailed", { error: openError })}
          </div>
        ) : null}
        {assetNames && assetNames.length > 0 ? (
          <div className="settings-about-update__assets">
            {assetNames.slice(0, 6).join(" · ")}
          </div>
        ) : null}
      </div>
    </div>
  );
}
