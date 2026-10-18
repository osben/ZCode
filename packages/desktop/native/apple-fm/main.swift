// zcode-apple-fm: tiny bridge from the ZCode Host to Apple's on-device Foundation Models.
//
// Protocol (JSON only, one request per process):
//   zcode-apple-fm availability   -> {"status":"available"} | {"status":"unavailable","reason":"..."}
//   zcode-apple-fm generate       -> reads {"prompt":"..."} from stdin, writes {"text":"..."}
//                                    or {"error":"..."} (exit code 1)
//
// Built with a low deployment target and the framework used only behind #available, so it links and
// runs on older macOS versions too, where it reports reason "unsupportedOS".

import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

func emit(_ object: [String: Any], exitCode: Int32 = 0) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(exitCode)
}

#if canImport(FoundationModels)
@available(macOS 26.0, *)
func availabilityObject() -> [String: Any] {
    switch SystemLanguageModel.default.availability {
    case .available:
        return ["status": "available"]
    case .unavailable(let reason):
        switch reason {
        case .deviceNotEligible:
            return ["status": "unavailable", "reason": "deviceNotEligible"]
        case .appleIntelligenceNotEnabled:
            return ["status": "unavailable", "reason": "appleIntelligenceNotEnabled"]
        case .modelNotReady:
            return ["status": "unavailable", "reason": "modelNotReady"]
        @unknown default:
            return ["status": "unavailable", "reason": "unknown"]
        }
    }
}

@available(macOS 26.0, *)
func generate(prompt: String) async throws -> String {
    let session = LanguageModelSession()
    // Greedy sampling: rewriting dictated text should be deterministic, not creative.
    let response = try await session.respond(to: prompt, options: GenerationOptions(sampling: .greedy))
    return response.content
}
#endif

let arguments = CommandLine.arguments.dropFirst()

switch arguments.first {
case "availability":
    #if canImport(FoundationModels)
    if #available(macOS 26.0, *) {
        emit(availabilityObject())
    }
    #endif
    emit(["status": "unavailable", "reason": "unsupportedOS"])

case "generate":
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard
        let json = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
        let prompt = json["prompt"] as? String, !prompt.isEmpty
    else {
        emit(["error": "invalid request: expected {\"prompt\": \"...\"}"], exitCode: 1)
    }
    #if canImport(FoundationModels)
    if #available(macOS 26.0, *) {
        do {
            emit(["text": try await generate(prompt: prompt)])
        } catch {
            emit(["error": String(describing: error)], exitCode: 1)
        }
    }
    #endif
    emit(["error": "unsupportedOS"], exitCode: 1)

default:
    emit(["error": "usage: zcode-apple-fm availability|generate"], exitCode: 2)
}
