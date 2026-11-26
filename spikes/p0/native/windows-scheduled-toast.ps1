#requires -Version 5.1
#requires -PSEdition Desktop
# Inspect WinRT and construct a request in memory. This probe never opens a notifier.
$ErrorActionPreference = 'Stop'
$metadata = [Windows.Foundation.Metadata.ApiInformation,Windows.Foundation.FoundationContract,ContentType=WindowsRuntime]
$notifierType = 'Windows.UI.Notifications.ToastNotifier'
foreach ($method in 'AddToSchedule', 'GetScheduledToastNotifications', 'RemoveFromSchedule') {
    if (-not $metadata::IsMethodPresent($notifierType, $method)) {
        throw "Missing WinRT method $notifierType.$method"
    }
}

$payload = [Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]::new()
$payload.LoadXml('<toast><visual><binding template="ToastGeneric"><text>Klaxon synthetic fixture</text></binding></visual></toast>')
$due = [DateTimeOffset]::UtcNow.AddHours(1)
$request = [Windows.UI.Notifications.ScheduledToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime]::new($payload, $due)
$request.Group = 'p0-device'
$request.Tag = 'p0-occurrence'

if ($request.Group -cne 'p0-device' -or $request.Tag -cne 'p0-occurrence' -or
    $request.DeliveryTime.UtcDateTime.Ticks -ne $due.UtcDateTime.Ticks) {
    throw 'Scheduled notification did not retain its group, tag and UTC due time.'
}
Write-Output "Windows $([Environment]::OSVersion.Version): scheduling API present; in-memory group, tag and due time verified."
