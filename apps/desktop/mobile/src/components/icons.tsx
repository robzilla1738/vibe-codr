// Lucide icon wrappers — the mobile app uses the same Lucide set + thin stroke
// defaults as the desktop (src/renderer/icons.tsx) so chrome icons read
// identically. color is inherited from the parent via currentColor-ish: pass an
// explicit color (defaults to the theme assistant).
import {
  PanelLeft, SquareTerminal, Settings, LayoutDashboard, X, Plus, Folder, FolderOpen,
  Search, ChevronRight, ChevronLeft, FileText, Paperclip, ArrowUp, Square, Brain,
  GitBranch, Cloud, MessageSquare, Check, RotateCcw, Pencil, Trash2, Archive, MoreVertical,
  ExternalLink, Copy, Link, ArrowRight, CornerUpLeft, Laptop, Command, QrCode,
  List, Columns3, SlidersHorizontal, CircleDot, CheckCircle2, MessagesSquare,
} from "lucide-react-native";
import type { ComponentProps } from "react";

export type IconName = keyof typeof ICONS;

const stroke = 1.5;

const ICONS = {
  PanelLeft, SquareTerminal, Settings, LayoutDashboard, X, Plus, Folder, FolderOpen,
  Search, ChevronRight, ChevronLeft, FileText, Paperclip, ArrowUp, Square, Brain,
  GitBranch, Cloud, MessageSquare, Check, RotateCcw, Pencil, Trash2, Archive, MoreVertical,
  ExternalLink, Copy, Link, ArrowRight, CornerUpLeft, Laptop, Command, QrCode,
  List, Columns3, SlidersHorizontal, CircleDot, CheckCircle2, MessagesSquare,
};

export type IconProps = { size?: number; color?: string; strokeWidth?: number };

export function Icon({ name, size = 18, color, strokeWidth = stroke }: { name: IconName } & IconProps) {
  const Cmp = ICONS[name];
  return <Cmp size={size} color={color} strokeWidth={strokeWidth} />;
}

export { PanelLeft, SquareTerminal, Settings, LayoutDashboard, X, Plus, Folder, FolderOpen, Search, ChevronRight, ChevronLeft, FileText, Paperclip, ArrowUp, Square, Brain, GitBranch, Cloud, MessageSquare, Check, RotateCcw, Pencil, Trash2, Archive, MoreVertical, ExternalLink, Copy, Link, ArrowRight, CornerUpLeft, Laptop, Command, QrCode, List, Columns3, SlidersHorizontal, CircleDot, CheckCircle2, MessagesSquare };
export type LucideIconProps = ComponentProps<typeof PanelLeft>;
