/**
 * App icons — Tabler Icons only (https://tabler.io/icons).
 * Stable `Icon*` names for call sites. No other icon libraries / local SVG packs.
 */

import type { ComponentType } from "react";
import {
  IconActivity as TbActivity,
  IconAdjustmentsHorizontal as TbAdjustmentsHorizontal,
  IconAlertTriangle as TbAlertTriangle,
  IconArrowsMaximize as TbArrowsMaximize,
  IconArchive as TbArchive,
  IconArrowBackUp as TbArrowBackUp,
  IconArrowLeft as TbArrowLeft,
  IconArrowUp as TbArrowUp,
  IconCircleArrowUp as TbCircleArrowUp,
  IconArrowsMinimize as TbArrowsMinimize,
  IconFocus2 as TbFocus2,
  IconBlockquote as TbBlockquote,
  IconBell as TbBell,
  IconBellOff as TbBellOff,
  IconBold as TbBold,
  IconBolt as TbBolt,
  IconBrandGithub as TbBrandGithub,
  IconGitBranch as TbGitBranch,
  IconGitCommit as TbGitCommit,
  IconBox as TbBox,
  IconBrush as TbBrush,
  IconCalendarTime as TbCalendarTime,
  IconCheck as TbCheck,
  IconClipboardList as TbClipboardList,
  IconClock as TbClock,
  IconCode as TbCode,
  IconChevronDown as TbChevronDown,
  IconChevronLeft as TbChevronLeft,
  IconChevronRight as TbChevronRight,
  IconChevronUp as TbChevronUp,
  IconChevronsLeft as TbChevronsLeft,
  IconBulb as TbBulb,
  IconCircle as TbCircle,
  IconCircleDashed as TbCircleDashed,
  IconCopy as TbCopy,
  IconGridDots as TbGridDots,
  IconGripVertical as TbGripVertical,
  IconDeviceDesktop as TbDeviceDesktop,
  IconDeviceMobile as TbDeviceMobile,
  IconDots as TbDots,
  IconCrop as TbCrop,
  IconEdit as TbEdit,
  IconEye as TbEye,
  IconH1 as TbH1,
  IconH2 as TbH2,
  IconH3 as TbH3,
  IconItalic as TbItalic,
  IconFileDiff as TbFileDiff,
  IconFileText as TbFileText,
  IconFiles as TbFiles,
  IconFirstAidKit as TbFirstAidKit,
  IconFolder as TbFolder,
  IconFolderPlus as TbFolderPlus,
  IconHandStop as TbHandStop,
  IconHelp as TbHelp,
  IconInfoCircle as TbInfoCircle,
  IconKeyboard as TbKeyboard,
  IconLanguage as TbLanguage,
  IconExternalLink as TbExternalLink,
  IconLayoutSidebar as TbLayoutSidebar,
  IconLayoutSidebarRight as TbLayoutSidebarRight,
  IconLink as TbLink,
  IconList as TbList,
  IconListCheck as TbListCheck,
  IconListNumbers as TbListNumbers,
  IconListTree as TbListTree,
  IconMarkdown as TbMarkdown,
  IconMenu2 as TbMenu2,
  IconMessage as TbMessage,
  IconMicrophone as TbMicrophone,
  IconHeadphones as TbHeadphones,
  IconMinus as TbMinus,
  IconMoon as TbMoon,
  IconNotes as TbNotes,
  IconPaperclip as TbPaperclip,
  IconPencil as TbPencil,
  IconPinned as TbPinned,
  IconPinnedOff as TbPinnedOff,
  IconPlayerStop as TbPlayerStop,
  IconPlug as TbPlug,
  IconPlus as TbPlus,
  IconPuzzle as TbPuzzle,
  IconRefresh as TbRefresh,
  IconRobot as TbRobot,
  IconSearch as TbSearch,
  IconSend as TbSend,
  IconSeparator as TbSeparator,
  IconSettings as TbSettings,
  IconShield as TbShield,
  IconShieldCheck as TbShieldCheck,
  IconSparkles as TbSparkles,
  IconSquare as TbSquare,
  IconStack2 as TbStack2,
  IconStrikethrough as TbStrikethrough,
  IconSun as TbSun,
  IconTarget as TbTarget,
  IconTerminal2 as TbTerminal2,
  IconThumbDown as TbThumbDown,
  IconThumbUp as TbThumbUp,
  IconTool as TbTool,
  IconTrash as TbTrash,
  IconUpload as TbUpload,
  IconUser as TbUser,
  IconPhoto as TbPhoto,
  IconWand as TbWand,
  IconWorld as TbWorld,
  IconX as TbX,
} from "@tabler/icons-react";

export type IconProps = {
  size?: number;
  title?: string;
  className?: string;
  stroke?: number;
  /** @deprecated No-op; call-site compatibility with previous icon APIs. */
  animated?: boolean;
  /** @deprecated No-op; call-site compatibility with Phosphor weight. */
  weight?: string;
};

type TbIcon = ComponentType<{
  size?: number | string;
  stroke?: number;
  color?: string;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

function wrap(Tb: TbIcon, defaults?: { stroke?: number; className?: string }) {
  function TablerAppIcon({
    size = 18,
    title,
    stroke = defaults?.stroke ?? 1.75,
    className = "",
    animated: _a,
    weight: _w,
  }: IconProps) {
    const classes = ["g-icon", defaults?.className, className]
      .filter(Boolean)
      .join(" ");
    return (
      <span
        className={classes}
        style={{
          display: "inline-flex",
          width: size,
          height: size,
          lineHeight: 0,
          color: "currentColor",
          flexShrink: 0,
          alignItems: "center",
          justifyContent: "center",
        }}
        role={title ? "img" : undefined}
        aria-hidden={title ? undefined : true}
        aria-label={title}
        title={title}
      >
        <Tb size={size} stroke={stroke} color="currentColor" aria-hidden />
      </span>
    );
  }
  return TablerAppIcon;
}

/**
 * Aiko's native mark (currentColor) — follows theme via CSS color.
 * The linked nodes express the Contract substrate's connected decisions.
 */
export function IconAikoMark({
  size = 22,
  title = "Aiko",
  className = "",
}: IconProps) {
  const classes = ["g-icon", "g-icon--aiko-mark", className]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      className={classes}
      style={{
        display: "inline-flex",
        width: size,
        height: size,
        lineHeight: 0,
        color: "currentColor",
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
      }}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      title={title}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 35 33"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
      >
        <path
          d="M17.5 2.5 31.5 29h-6.4l-2.8-5.8h-9.6L9.9 29H3.5L17.5 2.5Zm0 9.1-2.8 6h5.6l-2.8-6Z"
          fill="currentColor"
        />
        <circle cx="17.5" cy="5" r="2.5" fill="currentColor" />
        <circle cx="6.7" cy="27.4" r="2.5" fill="currentColor" />
        <circle cx="28.3" cy="27.4" r="2.5" fill="currentColor" />
      </svg>
    </span>
  );
}

export const IconCollapse = wrap(TbChevronsLeft);
export const IconSearch = wrap(TbSearch);
/** New chat / compose — Tabler Edit (pencil writing on paper). */
export const IconNewChat = wrap(TbEdit);
export const IconEdit = wrap(TbEdit);
/** Markdown / TipTap format toolbar */
export const IconBold = wrap(TbBold);
export const IconItalic = wrap(TbItalic);
export const IconStrikethrough = wrap(TbStrikethrough);
export const IconCode = wrap(TbCode);
export const IconH1 = wrap(TbH1);
export const IconH2 = wrap(TbH2);
export const IconH3 = wrap(TbH3);
export const IconListNumbers = wrap(TbListNumbers);
export const IconBlockquote = wrap(TbBlockquote);
export const IconSeparator = wrap(TbSeparator);
/** Wallpaper focus / crop frame editor. */
export const IconCrop = wrap(TbCrop);
export const IconNotes = wrap(TbNotes);
export const IconImagine = wrap(TbWand);
export const IconAutomations = wrap(TbBolt);
/** Scheduled / “已安排” nav — calendar clock. */
export const IconScheduled = wrap(TbCalendarTime);
export const IconClock = wrap(TbClock);
export const IconSkills = wrap(TbTool);
/** Lifecycle hooks (PreToolUse / SessionStart, …). */
export const IconHooks = wrap(TbBolt);
export const IconChevronDown = wrap(TbChevronDown);
export const IconChevronLeft = wrap(TbChevronLeft);
export const IconChevronRight = wrap(TbChevronRight);
export const IconChevronUp = wrap(TbChevronUp);
export const IconFolderPlus = wrap(TbFolderPlus);
export const IconPlus = wrap(TbPlus);
export const IconMore = wrap(TbDots);
export const IconFolder = wrap(TbFolder);
export const IconRename = wrap(TbPencil);
export const IconShare = wrap(TbLink);
export const IconLink = wrap(TbLink);
export const IconTrash = wrap(TbTrash, { className: "g-icon--danger" });
export const IconPaperclip = wrap(TbPaperclip);
export const IconAttach = wrap(TbPaperclip);
export const IconClose = wrap(TbX);
export const IconSend = wrap(TbSend);
/** Up arrow — composer send button glyph. */
export const IconArrowUp = wrap(TbArrowUp);
/** Circle arrow up — sidebar / About app update affordance. */
export const IconCircleArrowUp = wrap(TbCircleArrowUp);
export const IconQueue = wrap(TbStack2);
export const IconMic = wrap(TbMicrophone);
export const IconLiveVoice = wrap(TbHeadphones);
export const IconPanel = wrap(TbLayoutSidebar);
/** Hamburger / phone session drawer toggle. */
export const IconMenu = wrap(TbMenu2);
/** Right files / context pane (Codex-style top bar). */
export const IconPanelRight = wrap(TbLayoutSidebarRight);
/** Environment info menu (env ··|· knobs). */
export const IconEnv = wrap(TbAdjustmentsHorizontal);
export const IconBrandGithub = wrap(TbBrandGithub);
export const IconGitCommit = wrap(TbGitCommit);
/** Expand side workbench into chat area (四角外扩). */
export const IconSideExpand = wrap(TbArrowsMaximize);
/** Floating composer toggle when side is expanded. */
export const IconFloatComposer = wrap(TbMessage);
/** Drag handle for the floating composer card. */
export const IconDragHandle = wrap(TbGripVertical);
/** Terminal tab. */
export const IconTerminal = wrap(TbTerminal2);
/** Open project in Finder / external app. */
export const IconExternalLink = wrap(TbExternalLink);
export const IconList = wrap(TbList);
/** Sidebar multi-select / checklist mode. */
export const IconListCheck = wrap(TbListCheck);
export const IconInstructions = wrap(TbFileText);
export const IconSettings = wrap(TbSettings);
export const IconDoctor = wrap(TbFirstAidKit);
export const IconThemeSun = wrap(TbSun);
export const IconThemeMoon = wrap(TbMoon);
/** Composer stop action — outline player stop. */
export const IconStop = wrap(TbPlayerStop);
export const IconHistory = wrap(TbRefresh);
/** Session rewind / undo conversation tail. */
export const IconRewind = wrap(TbArrowBackUp);
/** Session fork / branch. */
export const IconFork = wrap(TbGitBranch);
/** Git branch indicator (composer context bar). */
export const IconGitBranch = wrap(TbGitBranch);
/** Local machine / desktop workspace. */
export const IconDeviceDesktop = wrap(TbDeviceDesktop);
export const IconUpload = wrap(TbUpload);
export const IconFiles = wrap(TbFiles);
/** Session changes / diff panel (resource viewer). */
export const IconFileDiff = wrap(TbFileDiff);
/** File tree panel toggle (resource viewer). */
export const IconListTree = wrap(TbListTree);
export const IconFileUp = wrap(TbUpload);
export const IconCart = wrap(TbBolt);
export const IconThumbsUp = wrap(TbThumbUp);
export const IconThumbsDown = wrap(TbThumbDown);
export const IconRefresh = wrap(TbRefresh);
export const IconCopy = wrap(TbCopy);
/** View / preview (review tree row). */
export const IconEye = wrap(TbEye);
/** Connect phone / remote mirror. */
export const IconDeviceMobile = wrap(TbDeviceMobile);
export const IconExportMd = wrap(TbMarkdown);
/** Conversation share-card / export as image. */
export const IconExportImage = wrap(TbPhoto);
export const IconArchive = wrap(TbArchive);
export const IconChat = wrap(TbMessage);
export const IconFileText = wrap(TbFileText);
export const IconBolt = wrap(TbBolt);
export const IconMinimize = wrap(TbMinus);
export const IconMaximize = wrap(TbSquare);
export const IconPlan = wrap(TbList);
export const IconPin = wrap(TbPinned);
export const IconPinOff = wrap(TbPinnedOff);
/** Per-session desktop notification mute (sidebar / context menu). */
export const IconBell = wrap(TbBell);
export const IconBellOff = wrap(TbBellOff);
export const IconHandStop = wrap(TbHandStop);
export const IconShield = wrap(TbShield);
export const IconShieldCheck = wrap(TbShieldCheck);
export const IconAlertTriangle = wrap(TbAlertTriangle);
export const IconCheck = wrap(TbCheck);
export const IconRobot = wrap(TbRobot);
export const IconArrowLeft = wrap(TbArrowLeft);
export const IconUser = wrap(TbUser);
export const IconAppearance = wrap(TbBrush);
export const IconLanguage = wrap(TbLanguage);
export const IconInfo = wrap(TbInfoCircle);
/** Help / “?” tip trigger next to settings labels. */
export const IconHelp = wrap(TbHelp);
export const IconKeyboard = wrap(TbKeyboard);
/** Slash palette / goal mode */
export const IconTarget = wrap(TbTarget);
export const IconClipboardList = wrap(TbClipboardList);
export const IconArrowsMinimize = wrap(TbArrowsMinimize);
/** Zen mode — hide side panes and focus the chat. */
export const IconZen = wrap(TbFocus2);

/**
 * Two chevrons facing each other (∨ above ∧) — collapse all project folders.
 * Glyph is slightly inset with a clearer mid gap; stroke stays Tabler 1.75
 * so weight matches IconPlus at the same box size.
 */
export function IconArrowsVerticalCollapse({
  size = 15,
  title,
  stroke = 1.75,
  className = "",
}: IconProps) {
  const classes = ["g-icon", className].filter(Boolean).join(" ");
  return (
    <span
      className={classes}
      style={{
        display: "inline-flex",
        width: size,
        height: size,
        lineHeight: 0,
        color: "currentColor",
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
      }}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      title={title}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
      >
        {/* Upper chevron: ∨ — smaller, higher */}
        <path
          d="M8.5 7L12 10.25L15.5 7"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Lower chevron: ∧ — smaller, lower (wider mid gap) */}
        <path
          d="M8.5 17L12 13.75L15.5 17"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
export const IconCircleDashed = wrap(TbCircleDashed);
/** Hollow circle — Grok timeline intermediate tool steps. */
export const IconCircle = wrap(TbCircle);
/** Lightbulb — Grok timeline thinking rows. */
export const IconBulb = wrap(TbBulb);
/** Globe — Grok timeline "Browsed …" rows. */
export const IconWorld = wrap(TbWorld);
/** 6-dot grid — Grok "Working for Ns" live indicator. */
export const IconGridDots = wrap(TbGridDots);
export const IconPlug = wrap(TbPlug);
export const IconActivity = wrap(TbActivity);
export const IconSparkles = wrap(TbSparkles);
export const IconBox = wrap(TbBox);
export const IconPuzzle = wrap(TbPuzzle);
