import type { LucideProps } from "lucide-react";
import {
  Archive,
  ArrowRight,
  ArrowUp,
  Brain,
  Check,
  ChevronRight,
  Cloud,
  Copy,
  CornerUpLeft,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  Globe,
  Laptop,
  LayoutDashboard,
  Link,
  MessageSquare,
  MoreVertical,
  PanelLeft,
  PanelRight,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Square,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";

/** Shared Lucide stroke defaults — OpenCode-like thin chrome icons. */
export type IconProps = {
  className?: string;
  size?: number;
  strokeWidth?: number;
};

const DEFAULTS = { size: 14, strokeWidth: 1.5, "aria-hidden": true as const };

function lucide(props: IconProps): LucideProps {
  return {
    ...DEFAULTS,
    ...props,
  };
}

export function IconPlus(props: IconProps) {
  return <Plus {...lucide(props)} />;
}

export function IconChat(props: IconProps) {
  return <MessageSquare {...lucide(props)} />;
}

export function IconFolder(props: IconProps) {
  return <Folder {...lucide(props)} />;
}

export function IconFolderOpen(props: IconProps) {
  return <FolderOpen {...lucide(props)} />;
}

export function IconContinue(props: IconProps) {
  return <RotateCcw {...lucide(props)} />;
}

export function IconSearch(props: IconProps) {
  return <Search {...lucide(props)} />;
}

export function IconChevronLeft(props: IconProps) {
  const className = `icon-chevron-left${props.className ? ` ${props.className}` : ""}`;
  return <ChevronRight {...lucide({ ...props, className })} />;
}

export function IconChevron({ open, className, size = 14 }: IconProps & { open?: boolean }) {
  return (
    <ChevronRight
      {...lucide({ size, className: `icon-chevron${open ? " is-open" : ""}${className ? ` ${className}` : ""}` })}
    />
  );
}

export function IconFile(props: IconProps) {
  return <FileText {...lucide(props)} />;
}

export function IconPaperclip(props: IconProps) {
  return <Paperclip {...lucide(props)} />;
}

export function IconSend(props: IconProps) {
  return <ArrowUp {...lucide({ size: 14, ...props })} />;
}

export function IconStop(props: IconProps) {
  return <Square {...lucide({ size: 10, strokeWidth: 0, ...props })} fill="currentColor" />;
}

export function IconJobs(props: IconProps) {
  return <LayoutDashboard {...lucide(props)} />;
}

export function IconTerminal(props: IconProps) {
  return <SquareTerminal {...lucide(props)} />;
}

export function IconDiff(props: IconProps) {
  return <FileText {...lucide(props)} />;
}

export function IconSidebar(props: IconProps) {
  return <PanelLeft {...lucide(props)} />;
}

export function IconMore(props: IconProps) {
  return <MoreVertical {...lucide(props)} />;
}

export function IconPanel(props: IconProps) {
  return <PanelRight {...lucide(props)} />;
}

export function IconBrain(props: IconProps) {
  return <Brain {...lucide(props)} />;
}

export function IconSteer(props: IconProps) {
  return <CornerUpLeft {...lucide(props)} />;
}

export function IconRemove(props: IconProps) {
  return <X {...lucide(props)} />;
}

export function IconRename(props: IconProps) {
  return <Pencil {...lucide(props)} />;
}

export function IconArchive(props: IconProps) {
  return <Archive {...lucide(props)} />;
}

export function IconDelete(props: IconProps) {
  return <Trash2 {...lucide(props)} />;
}

export function IconClose(props: IconProps) {
  return <X {...lucide(props)} />;
}

export function IconArrowRight(props: IconProps) {
  return <ArrowRight {...lucide(props)} />;
}

export function IconLink(props: IconProps) {
  return <Link {...lucide(props)} />;
}

export function IconCopy(props: IconProps) {
  return <Copy {...lucide(props)} />;
}

export function IconCheck(props: IconProps) {
  return <Check {...lucide(props)} />;
}

export function IconCloud(props: IconProps) {
  return <Cloud {...lucide(props)} />;
}

export function IconLaptop(props: IconProps) {
  return <Laptop {...lucide(props)} />;
}

export function IconSettings(props: IconProps) {
  return <Settings {...lucide(props)} />;
}

export function IconGitBranch(props: IconProps) {
  return <GitBranch {...lucide(props)} />;
}

export function IconExternalLink(props: IconProps) {
  return <ExternalLink {...lucide(props)} />;
}

export function IconBrowser(props: IconProps) {
  return <Globe {...lucide(props)} />;
}
