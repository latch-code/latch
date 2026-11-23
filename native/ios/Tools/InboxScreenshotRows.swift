import Foundation
import CoreImage
import Vision

// Read only the expected public fixture labels. The left edge distinguishes a flat row from a team member.
let args = CommandLine.arguments.dropFirst(2)
let settled = args.first == "--settled"
let words = Array(settled ? args.dropFirst() : args)
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let image = CIImage(contentsOf: url)!
let context = CIContext(options: [.workingColorSpace: NSNull()])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
try VNImageRequestHandler(url: url).perform([request])
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
            positions[word, default: []].append(match.boundingBox.minX)
        }
    }
}
FileHandle.standardOutput.write(try JSONEncoder().encode(positions))
