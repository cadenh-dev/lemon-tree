import AppKit

// Electron's ShareMenu lists every share service. This helper opens only the AirDrop device picker.
// It exits with 0 when the picker closes. macOS reports a share also when the user clicks Cancel,
// so exit 0 does not confirm delivery.

final class PickerDelegate: NSObject, NSSharingServiceDelegate {
  func sharingService(_ sharingService: NSSharingService, didShareItems items: [Any]) {
    exit(0)
  }

  func sharingService(_ sharingService: NSSharingService, didFailToShareItems items: [Any], error: Error) {
    if (error as NSError).code == NSUserCancelledError { exit(0) }
    fail(error.localizedDescription)
  }
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data(message.utf8))
  exit(1)
}

guard CommandLine.arguments.count == 2 else { fail("Give one file path.") }
let file = URL(fileURLWithPath: CommandLine.arguments[1])
guard let service = NSSharingService(named: .sendViaAirDrop), service.canPerform(withItems: [file]) else {
  fail("This Mac cannot send files to nearby Macs. Turn on Wi-Fi and Bluetooth.")
}
let delegate = PickerDelegate()
service.delegate = delegate
// An accessory app shows the picker without a Dock icon or a menu bar.
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.activate()
service.perform(withItems: [file])
NSApplication.shared.run()
