#pragma once

#include "Modules/ModuleInterface.h"
#include "Templates/SharedPointer.h"
#include "Containers/Ticker.h"

struct FProgressNotificationHandle;
class FAssetHiveTCPServer;

class FAssetHiveModule : public IModuleInterface
{
public:
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;

private:
    bool TickConnection(float DeltaTime);
    void UpdateConnectionState();
    void WriteEditorBridgeState();
    void ConsumeImportRequest();
    void ConsumeImportSignal();
    void StartImportNotification();
    void UpdateImportNotification(float Percent, const FString& Message);
    void FinishImportNotification(bool bSuccess, const FString& Message);
    void OnTCPMessageReceived(const FString& Message);
    void HandleTCPImportRequest(const FString& JobFile, const FString& RequestId);

    TUniquePtr<FAssetHiveTCPServer> TCPServer;
    TSharedPtr<TAtomic<bool>> LifetimeToken;
    bool bConnectedToAssetHive = false;
    int64 StartupTimestampMs = 0;
    int64 LastImportSignalTimestamp = 0;
    int64 LastImportRequestTimestamp = 0;
    FTSTicker::FDelegateHandle TickHandle;
    TSharedPtr<FProgressNotificationHandle> ImportProgressHandle;
    int32 LastImportPercent = 0;
};
