import SwiftUI
import WidgetKit

/** The extension's widgets: the waiting-question Live Activity, and Harness quota on the Home and Lock Screens. */
@main struct LatchWidgets: WidgetBundle {
    var body: some Widget {
        LatchQuestionWidget()
        LatchQuotaWidget()
    }
}
