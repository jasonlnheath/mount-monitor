import QtQuick

// The view of the bar that this plugin's PopupCards see. A PopupCard
// coordinates popouts through its owner - open registers the owner with the
// bar, close releases it, and another popout's opening calls the owner's
// closeForPopoutSwitch - and this plugin's cards are owned by their panels,
// which is what keeps every window closable from itself. The bar keys the
// open-panel dot and popout switching on the bar-widget root, so the widget
// registers itself instead, driven by the panels' opened state
// (MemoryMonitor.qml, syncPopout). This facade answers the card's geometry
// reads from the real bar api and lets the card's own coordination calls
// fall harmless.
QtObject {
  property var api: null

  // The one bar property PopupCard reads for geometry.
  readonly property string position: api ? api.position : "top"

  property var activePopout: null

  function requestPopout(owner) {}
  function releasePopout(owner) {}
}
