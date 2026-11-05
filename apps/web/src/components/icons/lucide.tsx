// The app's glyphs: Lucide (ISC licence), round and outlined, drawn at stroke 1.5 so they read as
// thin as the type beside them. Each export keeps the name its call sites use; size and colour
// come from the caller's classes, as before.
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleAlert,
  CircleX,
  Copy,
  CreditCard,
  Ellipsis,
  Globe,
  Inbox,
  Info,
  KeyRound,
  Keyboard,
  Laptop,
  List,
  Mail,
  Mailbox,
  Pencil,
  Plus,
  Send,
  Settings,
  Shield,
  Smartphone,
  Star,
  Tablet,
  Trash,
  Upload,
  UserCog,
  UserMinus,
  Users,
  UsersRound,
  CircleCheck,
  CircleHelp,
  Clock3,
  TriangleAlert,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

function thin(Icon: LucideIcon, name: string) {
  const Thin = (props: LucideProps) => <Icon aria-hidden strokeWidth={1.5} {...props} />;
  Thin.displayName = name;
  return Thin;
}

export const IconArrowUpRight = thin(ArrowUpRight, "IconArrowUpRight");
export const IconCheck = thin(Check, "IconCheck");
export const IconChevronDown = thin(ChevronDown, "IconChevronDown");
export const IconChevronRight = thin(ChevronRight, "IconChevronRight");
export const IconChevronsUpDown = thin(ChevronsUpDown, "IconChevronsUpDown");
export const IconCircleAlert = thin(CircleAlert, "IconCircleAlert");
export const IconCircleX = thin(CircleX, "IconCircleX");
export const IconCopy = thin(Copy, "IconCopy");
export const IconCreditCard = thin(CreditCard, "IconCreditCard");
export const IconEllipsis = thin(Ellipsis, "IconEllipsis");
export const IconGlobe = thin(Globe, "IconGlobe");
export const IconInbox = thin(Inbox, "IconInbox");
export const IconInfo = thin(Info, "IconInfo");
export const IconKey = thin(KeyRound, "IconKey");
export const IconKeyboard = thin(Keyboard, "IconKeyboard");
export const IconLaptop = thin(Laptop, "IconLaptop");
export const IconList = thin(List, "IconList");
export const IconMail = thin(Mail, "IconMail");
export const IconMailbox = thin(Mailbox, "IconMailbox");
export const IconPencil = thin(Pencil, "IconPencil");
export const IconPlus = thin(Plus, "IconPlus");
export const IconSend = thin(Send, "IconSend");
export const IconSettings = thin(Settings, "IconSettings");
export const IconShield = thin(Shield, "IconShield");
export const IconSmartphone = thin(Smartphone, "IconSmartphone");
export const IconStar = thin(Star, "IconStar");
export const IconTablet = thin(Tablet, "IconTablet");
export const IconTrash = thin(Trash, "IconTrash");
export const IconUpload = thin(Upload, "IconUpload");
export const IconUserCog = thin(UserCog, "IconUserCog");
export const IconUserMinus = thin(UserMinus, "IconUserMinus");
export const IconUsers = thin(Users, "IconUsers");
export const IconUsersRound = thin(UsersRound, "IconUsersRound");
export const IconCircleCheck = thin(CircleCheck, "IconCircleCheck");
export const IconCircleHelp = thin(CircleHelp, "IconCircleHelp");
export const IconClock3 = thin(Clock3, "IconClock3");
export const IconTriangleAlert = thin(TriangleAlert, "IconTriangleAlert");
