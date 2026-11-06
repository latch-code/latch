import Foundation

/**
 * A connected phone opens its content without asking. Face ID is the person's own choice in 设置, off by default; when it
 * is on, it is asked before each new content window, and the words and icons say so.
 */
public enum PhoneUnlock {
    /** The one way back into a session whose window closed, named for what tapping it does. */
    public static func reopenWords(faceID: Bool) -> String { faceID ? "用 Face ID 查看" : "查看" }
    /** The icon beside 「查看内容后可以回复」. */
    public static func closedWindowSymbol(faceID: Bool) -> String { faceID ? "faceid" : "eye" }
    /** Nothing asks the person when Face ID is off, so a window that ran out while open opens again by itself. */
    public static func reopensAtExpiry(faceID: Bool) -> Bool { !faceID }
}
