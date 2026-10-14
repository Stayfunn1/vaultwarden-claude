// Icons of entries and groups: the 69 standard icons of KeePass, custom images and website icons.
//
// KeePass identifies its standard icons by number. They are shown with matching icons of Lucide
// (https://lucide.dev, ISC license, see vendor/LICENSES.txt), as the KeePass images themselves can
// not be redistributed. Custom icons (from KeePass or added here) are small PNG images.

import { h, icon, clear, dialog, pickFiles, readFile } from "./ui.js";

// [KeePass name, color, SVG content (24x24, stroked)], indexed by the KeePass icon number
export const STANDARD_ICONS = [
    ["Key", "#c08a00", "<path d=\"M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z\"/> <circle cx=\"16.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\"/>"], // key-round
    ["World", "#2f7fd8", "<circle cx=\"12\" cy=\"12\" r=\"10\"/> <path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\"/> <path d=\"M2 12h20\"/>"], // globe
    ["Warning", "#d08700", "<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\"/> <path d=\"M12 9v4\"/> <path d=\"M12 17h.01\"/>"], // triangle-alert
    ["NetworkServer", "#5b6b7f", "<rect width=\"20\" height=\"8\" x=\"2\" y=\"2\" rx=\"2\" ry=\"2\"/> <rect width=\"20\" height=\"8\" x=\"2\" y=\"14\" rx=\"2\" ry=\"2\"/> <line x1=\"6\" x2=\"6.01\" y1=\"6\" y2=\"6\"/> <line x1=\"6\" x2=\"6.01\" y1=\"18\" y2=\"18\"/>"], // server
    ["MarkedDirectory", "#c49a1c", "<path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\"/> <path d=\"m9 13 2 2 4-4\"/>"], // folder-check
    ["UserCommunication", "#2f9d6a", "<path d=\"M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z\"/> <path d=\"M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1\"/>"], // messages-square
    ["Parts", "#8a5cc9", "<path d=\"M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z\"/>"], // puzzle
    ["Notepad", "#6b7f99", "<path d=\"M8 2v4\"/> <path d=\"M12 2v4\"/> <path d=\"M16 2v4\"/> <rect width=\"16\" height=\"18\" x=\"4\" y=\"4\" rx=\"2\"/> <path d=\"M8 10h6\"/> <path d=\"M8 14h8\"/> <path d=\"M8 18h5\"/>"], // notepad-text
    ["WorldSocket", "#2f7fd8", "<path d=\"M12 22v-5\"/> <path d=\"M9 8V2\"/> <path d=\"M15 8V2\"/> <path d=\"M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z\"/>"], // plug
    ["Identity", "#3d8bd9", "<path d=\"M16 10h2\"/> <path d=\"M16 14h2\"/> <path d=\"M6.17 15a3 3 0 0 1 5.66 0\"/> <circle cx=\"9\" cy=\"11\" r=\"2\"/> <rect x=\"2\" y=\"5\" width=\"20\" height=\"14\" rx=\"2\"/>"], // id-card
    ["PaperReady", "#2f9d6a", "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/> <path d=\"m9 15 2 2 4-4\"/>"], // file-check
    ["Digicam", "#5b6b7f", "<path d=\"M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z\"/> <circle cx=\"12\" cy=\"13\" r=\"3\"/>"], // camera
    ["IRCommunication", "#c9452e", "<path d=\"M4.9 16.1C1 12.2 1 5.8 4.9 1.9\"/> <path d=\"M7.8 4.7a6.14 6.14 0 0 0-.8 7.5\"/> <circle cx=\"12\" cy=\"9\" r=\"2\"/> <path d=\"M16.2 4.8c2 2 2.26 5.11.8 7.47\"/> <path d=\"M19.1 1.9a9.96 9.96 0 0 1 0 14.1\"/> <path d=\"M9.5 18h5\"/> <path d=\"m8 22 4-11 4 11\"/>"], // radio-tower
    ["MultiKeys", "#c08a00", "<path d=\"M12.4 2.7a2.5 2.5 0 0 1 3.4 0l5.5 5.5a2.5 2.5 0 0 1 0 3.4l-3.7 3.7a2.5 2.5 0 0 1-3.4 0L8.7 9.8a2.5 2.5 0 0 1 0-3.4z\"/> <path d=\"m14 7 3 3\"/> <path d=\"m9.4 10.6-6.814 6.814A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814\"/>"], // key-square
    ["Energy", "#e0a800", "<path d=\"M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z\"/>"], // zap
    ["Scanner", "#5b6b7f", "<path d=\"M3 7V5a2 2 0 0 1 2-2h2\"/> <path d=\"M17 3h2a2 2 0 0 1 2 2v2\"/> <path d=\"M21 17v2a2 2 0 0 1-2 2h-2\"/> <path d=\"M7 21H5a2 2 0 0 1-2-2v-2\"/> <path d=\"M7 12h10\"/>"], // scan-line
    ["WorldStar", "#2f7fd8", "<path d=\"M21.54 15H17a2 2 0 0 0-2 2v4.54\"/> <path d=\"M7 3.34V5a3 3 0 0 0 3 3a2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17\"/> <path d=\"M11 21.95V18a2 2 0 0 0-2-2a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05\"/> <circle cx=\"12\" cy=\"12\" r=\"10\"/>"], // earth
    ["CDRom", "#8a5cc9", "<circle cx=\"12\" cy=\"12\" r=\"10\"/> <path d=\"M6 12c0-1.7.7-3.2 1.8-4.2\"/> <circle cx=\"12\" cy=\"12\" r=\"2\"/> <path d=\"M18 12c0 1.7-.7 3.2-1.8 4.2\"/>"], // disc-3
    ["Monitor", "#3d6fb0", "<rect width=\"20\" height=\"14\" x=\"2\" y=\"3\" rx=\"2\"/> <line x1=\"8\" x2=\"16\" y1=\"21\" y2=\"21\"/> <line x1=\"12\" x2=\"12\" y1=\"17\" y2=\"21\"/>"], // monitor
    ["EMail", "#2f7fd8", "<path d=\"m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7\"/> <rect x=\"2\" y=\"4\" width=\"20\" height=\"16\" rx=\"2\"/>"], // mail
    ["Configuration", "#6b7f99", "<path d=\"M10 5H3\"/> <path d=\"M12 19H3\"/> <path d=\"M14 3v4\"/> <path d=\"M16 17v4\"/> <path d=\"M21 12h-9\"/> <path d=\"M21 19h-5\"/> <path d=\"M21 5h-7\"/> <path d=\"M8 10v4\"/> <path d=\"M8 12H3\"/>"], // sliders-horizontal
    ["ClipboardReady", "#2f9d6a", "<rect width=\"8\" height=\"4\" x=\"8\" y=\"2\" rx=\"1\" ry=\"1\"/> <path d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2\"/> <path d=\"m9 14 2 2 4-4\"/>"], // clipboard-check
    ["PaperNew", "#2f9d6a", "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/> <path d=\"M9 15h6\"/> <path d=\"M12 18v-6\"/>"], // file-plus
    ["Screen", "#3d6fb0", "<path d=\"m17 2-5 5-5-5\"/> <rect width=\"20\" height=\"15\" x=\"2\" y=\"7\" rx=\"2\"/>"], // tv
    ["EnergyCareful", "#d08700", "<path d=\"M10 17h.01\"/> <path d=\"M10 7v6\"/> <path d=\"M14 6h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2\"/> <path d=\"M22 14v-4\"/> <path d=\"M6 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2\"/>"], // battery-warning
    ["EMailBox", "#2f7fd8", "<polyline points=\"22 12 16 12 14 15 10 15 8 12 2 12\"/> <path d=\"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\"/>"], // inbox
    ["Disk", "#3d6fb0", "<path d=\"M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z\"/> <path d=\"M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7\"/> <path d=\"M7 3v4a1 1 0 0 0 1 1h7\"/>"], // save
    ["Drive", "#5b6b7f", "<line x1=\"22\" x2=\"2\" y1=\"12\" y2=\"12\"/> <path d=\"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\"/> <line x1=\"6\" x2=\"6.01\" y1=\"16\" y2=\"16\"/> <line x1=\"10\" x2=\"10.01\" y1=\"16\" y2=\"16\"/>"], // hard-drive
    ["PaperQ", "#8a5cc9", "<path d=\"M12 17h.01\"/> <path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z\"/> <path d=\"M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3\"/>"], // file-question
    ["TerminalEncrypted", "#2f9d6a", "<path d=\"m7 11 2-2-2-2\"/> <path d=\"M11 13h4\"/> <rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" ry=\"2\"/>"], // square-terminal
    ["Console", "#5b6b7f", "<path d=\"M12 19h8\"/> <path d=\"m4 17 6-6-6-6\"/>"], // terminal
    ["Printer", "#5b6b7f", "<path d=\"M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2\"/> <path d=\"M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6\"/> <rect x=\"6\" y=\"14\" width=\"12\" height=\"8\" rx=\"1\"/>"], // printer
    ["ProgramIcons", "#3d8bd9", "<rect width=\"7\" height=\"7\" x=\"3\" y=\"3\" rx=\"1\"/> <rect width=\"7\" height=\"7\" x=\"14\" y=\"3\" rx=\"1\"/> <rect width=\"7\" height=\"7\" x=\"14\" y=\"14\" rx=\"1\"/> <rect width=\"7\" height=\"7\" x=\"3\" y=\"14\" rx=\"1\"/>"], // layout-grid
    ["Run", "#2f9d6a", "<path d=\"M9 9.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997A1 1 0 0 1 9 14.996z\"/> <circle cx=\"12\" cy=\"12\" r=\"10\"/>"], // circle-play
    ["Settings", "#6b7f99", "<path d=\"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915\"/> <circle cx=\"12\" cy=\"12\" r=\"3\"/>"], // settings
    ["WorldComputer", "#2f7fd8", "<path d=\"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z\"/>"], // cloud
    ["Archive", "#9d6b2f", "<rect width=\"20\" height=\"5\" x=\"2\" y=\"3\" rx=\"1\"/> <path d=\"M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8\"/> <path d=\"M10 12h4\"/>"], // archive
    ["Homebanking", "#2f7f5a", "<path d=\"M10 18v-7\"/> <path d=\"M11.12 2.198a2 2 0 0 1 1.76.006l7.866 3.847c.476.233.31.949-.22.949H3.474c-.53 0-.695-.716-.22-.949z\"/> <path d=\"M14 18v-7\"/> <path d=\"M18 18v-7\"/> <path d=\"M3 22h18\"/> <path d=\"M6 18v-7\"/>"], // landmark
    ["DriveWindows", "#3d8bd9", "<rect x=\"2\" y=\"4\" width=\"20\" height=\"16\" rx=\"2\"/> <path d=\"M10 4v4\"/> <path d=\"M2 8h20\"/> <path d=\"M6 4v4\"/>"], // app-window
    ["Clock", "#5b6b7f", "<path d=\"M12 6v6l4 2\"/> <circle cx=\"12\" cy=\"12\" r=\"10\"/>"], // clock
    ["EMailSearch", "#2f7fd8", "<path d=\"M22 12.5V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h7.5\"/> <path d=\"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7\"/> <path d=\"M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z\"/> <circle cx=\"18\" cy=\"18\" r=\"3\"/> <path d=\"m22 22-1.5-1.5\"/>"], // mail-search
    ["PaperFlag", "#c9452e", "<path d=\"M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528\"/>"], // flag
    ["Memory", "#2f9d6a", "<path d=\"M6 19v-3\"/> <path d=\"M10 19v-3\"/> <path d=\"M14 19v-3\"/> <path d=\"M18 19v-3\"/> <path d=\"M8 11V9\"/> <path d=\"M16 11V9\"/> <path d=\"M12 11V9\"/> <path d=\"M2 15h20\"/> <path d=\"M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1.1a2 2 0 0 0 0 3.837V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5.1a2 2 0 0 0 0-3.837Z\"/>"], // memory-stick
    ["TrashBin", "#6b7f99", "<path d=\"M10 11v6\"/> <path d=\"M14 11v6\"/> <path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\"/> <path d=\"M3 6h18\"/> <path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"/>"], // trash-2
    ["Note", "#d0a400", "<path d=\"M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z\"/> <path d=\"M15 3v4a2 2 0 0 0 2 2h4\"/>"], // sticky-note
    ["Expired", "#c9452e", "<path d=\"M8 2v4\"/> <path d=\"M16 2v4\"/> <rect width=\"18\" height=\"18\" x=\"3\" y=\"4\" rx=\"2\"/> <path d=\"M3 10h18\"/> <path d=\"m14 14-4 4\"/> <path d=\"m10 14 4 4\"/>"], // calendar-x
    ["Info", "#2f7fd8", "<circle cx=\"12\" cy=\"12\" r=\"10\"/> <path d=\"M12 16v-4\"/> <path d=\"M12 8h.01\"/>"], // info
    ["Package", "#9d6b2f", "<path d=\"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z\"/> <path d=\"M12 22V12\"/> <polyline points=\"3.29 7 12 12 20.71 7\"/> <path d=\"m7.5 4.27 9 5.15\"/>"], // package
    ["Folder", "#c49a1c", "<path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\"/>"], // folder
    ["FolderOpen", "#c49a1c", "<path d=\"m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2\"/>"], // folder-open
    ["FolderPackage", "#c49a1c", "<circle cx=\"15\" cy=\"19\" r=\"2\"/> <path d=\"M20.9 19.8A2 2 0 0 0 22 18V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h5.1\"/> <path d=\"M15 11v-1\"/> <path d=\"M15 17v-2\"/>"], // folder-archive
    ["LockOpen", "#d08700", "<rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\"/> <path d=\"M7 11V7a5 5 0 0 1 9.9-1\"/>"], // lock-open
    ["PaperLocked", "#c08a00", "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/> <rect width=\"8\" height=\"6\" x=\"8\" y=\"12\" rx=\"1\"/> <path d=\"M10 12v-2a2 2 0 1 1 4 0v2\"/>"], // file-lock
    ["Checked", "#2f9d6a", "<circle cx=\"12\" cy=\"12\" r=\"10\"/> <path d=\"m9 12 2 2 4-4\"/>"], // circle-check
    ["Pen", "#3d8bd9", "<path d=\"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z\"/>"], // pen
    ["Thumbnail", "#8a5cc9", "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" ry=\"2\"/> <circle cx=\"9\" cy=\"9\" r=\"2\"/> <path d=\"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21\"/>"], // image
    ["Book", "#9d6b2f", "<path d=\"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20\"/>"], // book
    ["List", "#5b6b7f", "<path d=\"M3 5h.01\"/> <path d=\"M3 12h.01\"/> <path d=\"M3 19h.01\"/> <path d=\"M8 5h13\"/> <path d=\"M8 12h13\"/> <path d=\"M8 19h13\"/>"], // list
    ["UserKey", "#c08a00", "<circle cx=\"10\" cy=\"7\" r=\"4\"/> <path d=\"M10.3 15H7a4 4 0 0 0-4 4v2\"/> <path d=\"M15 15.5V14a2 2 0 0 1 4 0v1.5\"/> <rect width=\"8\" height=\"5\" x=\"13\" y=\"16\" rx=\".899\"/>"], // user-lock
    ["Tool", "#6b7f99", "<path d=\"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z\"/>"], // wrench
    ["Home", "#c9452e", "<path d=\"M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8\"/> <path d=\"M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/>"], // house
    ["Star", "#e0a800", "<path d=\"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z\"/>"], // star
    ["Tux", "#5b6b7f", "<path d=\"M16 7h.01\"/> <path d=\"M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20\"/> <path d=\"m20 7 2 .5-2 .5\"/> <path d=\"M10 18v3\"/> <path d=\"M14 17.75V21\"/> <path d=\"M7 18a6 6 0 0 0 3.84-10.61\"/>"], // bird
    ["Feather", "#3d8bd9", "<path d=\"M12.67 19a2 2 0 0 0 1.416-.588l6.154-6.172a6 6 0 0 0-8.49-8.49L5.586 9.914A2 2 0 0 0 5 11.328V18a1 1 0 0 0 1 1z\"/> <path d=\"M16 8 2 22\"/> <path d=\"M17.5 15H9\"/>"], // feather
    ["Apple", "#c9452e", "<path d=\"M12 6.528V3a1 1 0 0 1 1-1h0\"/> <path d=\"M18.237 21A15 15 0 0 0 22 11a6 6 0 0 0-10-4.472A6 6 0 0 0 2 11a15.1 15.1 0 0 0 3.763 10 3 3 0 0 0 3.648.648 5.5 5.5 0 0 1 5.178 0A3 3 0 0 0 18.237 21\"/>"], // apple
    ["Wiki", "#9d6b2f", "<path d=\"m16 6 4 14\"/> <path d=\"M12 6v14\"/> <path d=\"M8 8v12\"/> <path d=\"M4 4v16\"/>"], // library
    ["Money", "#2f7f5a", "<rect width=\"20\" height=\"12\" x=\"2\" y=\"6\" rx=\"2\"/> <circle cx=\"12\" cy=\"12\" r=\"2\"/> <path d=\"M6 12h.01M18 12h.01\"/>"], // banknote
    ["Certificate", "#d08700", "<path d=\"m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526\"/> <circle cx=\"12\" cy=\"8\" r=\"6\"/>"], // award
    ["BlackBerry", "#5b6b7f", "<rect width=\"14\" height=\"20\" x=\"5\" y=\"2\" rx=\"2\" ry=\"2\"/> <path d=\"M12 18h.01\"/>"], // smartphone
];

const BASE_URL = new URL("../", window.location.href).href.replace(/\/$/, "");

export function standardIcon(index, cls = "") {
    const def = STANDARD_ICONS[index] || STANDARD_ICONS[0];
    const span = document.createElement("span");
    span.className = `icon kp-icon ${cls}`;
    span.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="${def[1]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${def[2]}</svg>`;
    return span;
}

export function imageIcon(src, cls = "", fallback = null) {
    const img = h("img", { src, width: 16, height: 16, alt: "", draggable: "false" });
    const span = h("span", { class: `icon img-icon ${cls}` }, img);
    if (fallback) img.addEventListener("error", () => span.replaceWith(icon(fallback, cls)), { once: true });
    return span;
}

// An icon resolved by the icon store ({ standard } or { image }), or the given default icon
export function renderIcon(resolved, fallback, cls = "") {
    if (resolved && resolved.standard !== undefined) return standardIcon(resolved.standard, cls);
    if (resolved && resolved.image) return imageIcon(resolved.image, cls, fallback);
    return icon(fallback, cls);
}

// The icon of a website from the icon service of Vaultwarden
export function faviconIcon(host, fallback, cls = "") {
    return imageIcon(`${BASE_URL}/icons/${encodeURIComponent(host)}/icon.png`, cls, fallback);
}

// Shrinks an image file to a 32x32 PNG data URL (keeps the icons small)
async function imageFileToIcon(file) {
    const url = URL.createObjectURL(new Blob([await readFile(file)], { type: file.type || "image/png" }));
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const size = 32;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight, 1);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const hgt = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext("2d").drawImage(img, (size - w) / 2, (size - hgt) / 2, w, hgt);
        return canvas.toDataURL("image/png");
    } finally {
        URL.revokeObjectURL(url);
    }
}

// Lets the user choose an icon. `images` are the custom images available ({ ref, image }).
// Resolves with { standard }, { image }, { ref } (an existing custom image), { reset: true } or undefined (cancelled).
export function iconPickerDialog(title, current, images = []) {
    return dialog({
        title,
        width: "520px",
        build: (close) => {
            let choice = null;
            const buttons = [];
            const pick = (btn, value) => {
                for (const b of buttons) b.classList.remove("selected");
                btn.classList.add("selected");
                choice = value;
            };
            const tile = (content, label, value, selected) => {
                const btn = h("button", { type: "button", class: "icon-tile", title: label, "aria-label": label, onclick: () => pick(btn, value), ondblclick: () => close(value) }, content);
                buttons.push(btn);
                if (selected) pick(btn, value);
                return btn;
            };
            const standard = h(
                "div",
                { class: "icon-grid" },
                STANDARD_ICONS.map((def, i) => tile(standardIcon(i), `${i}: ${def[0]}`, { standard: i }, current?.standard === i)),
            );
            const custom = h("div", { class: "icon-grid" });
            const renderCustom = () => {
                clear(custom);
                for (const img of images) custom.appendChild(tile(imageIcon(img.image), "Custom icon", { ref: img.ref, image: img.image }, current?.ref === img.ref));
                custom.appendChild(
                    h("button", { type: "button", class: "icon-tile add", title: "Add an image (PNG, JPEG, GIF, SVG, ICO)", onclick: async () => {
                        const [file] = await pickFiles({ accept: "image/*,.ico" });
                        if (!file) return;
                        try {
                            const image = await imageFileToIcon(file);
                            images = [...images, { ref: null, image }];
                            renderCustom();
                            pick(buttons[buttons.length - 1], { image });
                        } catch {
                            /* not an image */
                        }
                    } }, "+"),
                );
            };
            renderCustom();
            return {
                body: h("div", { class: "form" }, h("h4", null, "Standard icons"), standard, h("h4", null, "Custom icons"), custom),
                buttons: [
                    h("button", { type: "button", class: "primary", onclick: () => close(choice || undefined) }, "OK"),
                    h("button", { type: "button", onclick: () => close({ reset: true }) }, "Default icon"),
                    h("button", { type: "button", onclick: () => close(undefined) }, "Cancel"),
                ],
            };
        },
    });
}
