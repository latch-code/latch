import Foundation
import CoreImage
import Vision

// Read only the expected public fixture labels. The left edge distinguishes a flat row from a team member.
let args = CommandLine.arguments.dropFirst(2)
let flags = args.prefix { $0.hasPrefix("--") }
let settled = flags.contains("--settled")
let vertical = flags.contains("--vertical")
let queueActions = flags.contains("--queue-actions")
let words = Array(args.dropFirst(flags.count))
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let screenshot = CIImage(contentsOf: url)!
let image: CIImage
if queueActions {
    // On a phone, omit the queue text and trailing menu and reorder icons that Vision sometimes joins to the action name.
    let left = floor(screenshot.extent.width * 0.5)
    let right = floor(screenshot.extent.width * 0.8)
    let column = CGRect(x: left, y: 0, width: right - left, height: screenshot.extent.height)
    image = screenshot.cropped(to: column).transformed(by: CGAffineTransform(translationX: -left, y: 0))
} else {
    image = screenshot
}
let context = CIContext(options: [.workingColorSpace: NSNull()])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
let reader = queueActions ? VNImageRequestHandler(ciImage: image) : VNImageRequestHandler(url: url)
try reader.perform([request])
var positions = Dictionary(uniqueKeysWithValues: words.map { ($0, [Double]()) })
for observation in request.results ?? [] {
    guard let text = observation.topCandidates(1).first else { continue }
    for word in words {
        let pattern = word.map { NSRegularExpression.escapedPattern(for: String($0)) }.joined(separator: #"\s*"#)
        if let range = text.string.range(of: pattern, options: .regularExpression),
           let match = try text.boundingBox(for: range) {
            if settled {
                // During the launch fade OCR can read nearly transparent text. Wait for normal ink contrast for the shared shot.
                let region = VNImageRectForNormalizedRect(match.boundingBox, Int(image.extent.width), Int(image.extent.height))
                let extrema = image.applyingFilter("CIAreaMinMax", parameters: [kCIInputExtentKey: CIVector(cgRect: region)])
                var pixels = [UInt8](repeating: 0, count: 8)
                context.render(extrema, toBitmap: &pixels, rowBytes: 8, bounds: extrema.extent, format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
                if Int(pixels[4]) - Int(pixels[0]) < 140 { continue }
            }
            positions[word, default: []].append(vertical ? 1 - match.boundingBox.midY : match.boundingBox.minX)
        }
    }
}
FileHandle.standardOutput.write(try JSONEncoder().encode(positions))
