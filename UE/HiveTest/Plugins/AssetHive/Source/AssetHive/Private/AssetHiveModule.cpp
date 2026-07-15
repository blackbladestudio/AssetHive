#include "AssetHiveModule.h"
#include "AssetHiveEditorToolbar.h"
#include "AssetHiveImportCommandlet.h"
#include "AssetHiveTCPServer.h"
#include "Async/Async.h"
#include "ContentBrowserModule.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/OutputDevice.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "IContentBrowserSingleton.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Framework/Notifications/NotificationManager.h"

IMPLEMENT_MODULE(FAssetHiveModule, AssetHive)

static FString GetBridgeHeartbeatPath()
{
    return FPaths::Combine(FPlatformProcess::UserDir(), TEXT("AssetHive"), TEXT("bridge-heartbeat.json"));
}

static FString GetImportSignalPath()
{
    return FPaths::Combine(FPlatformProcess::UserDir(), TEXT("AssetHive"), TEXT("import-signal.json"));
}

static FString GetEditorBridgeStatePath()
{
    return FPaths::Combine(FPlatformProcess::UserDir(), TEXT("AssetHive"), TEXT("editor-bridge.json"));
}

static FString GetImportRequestPath()
{
    return FPaths::Combine(FPlatformProcess::UserDir(), TEXT("AssetHive"), TEXT("import-request.json"));
}

static FString GetImportResponsePath()
{
    return FPaths::Combine(FPlatformProcess::UserDir(), TEXT("AssetHive"), TEXT("import-response.json"));
}

static FString MakeSafeFolderToken(const FString& Name)
{
    FString SafeName = Name;
    SafeName.ReplaceInline(TEXT(" "), TEXT("_"));
    SafeName.ReplaceInline(TEXT("-"), TEXT("_"));
    SafeName.ReplaceInline(TEXT("."), TEXT("_"));
    return SafeName;
}

static void WriteImportResponse(const FString& RequestId, bool bOk, const FString& Message)
{
    TSharedPtr<FJsonObject> Response = MakeShared<FJsonObject>();
    Response->SetStringField(TEXT("requestId"), RequestId);
    Response->SetNumberField(TEXT("timestamp"), static_cast<double>(FDateTime::UtcNow().ToUnixTimestamp()) * 1000.0);
    Response->SetBoolField(TEXT("ok"), bOk);
    Response->SetStringField(TEXT("message"), Message);
    FString Serialized;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Serialized);
    if (FJsonSerializer::Serialize(Response.ToSharedRef(), Writer)) {
        FFileHelper::SaveStringToFile(Serialized, *GetImportResponsePath());
    }
}

static TArray<FString> CollectExistingAssetFolders(const FString& JobFile)
{
    TArray<FString> ExistingFolders;
    FString JobContent;
    if (!FFileHelper::LoadFileToString(JobContent, *JobFile)) {
        return ExistingFolders;
    }
    TSharedPtr<FJsonObject> JobJson;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(JobContent);
    if (!FJsonSerializer::Deserialize(Reader, JobJson) || !JobJson.IsValid()) {
        return ExistingFolders;
    }
    const TArray<TSharedPtr<FJsonValue>>* Assets = nullptr;
    if (!JobJson->TryGetArrayField(TEXT("assets"), Assets) || Assets == nullptr) {
        return ExistingFolders;
    }
    for (const TSharedPtr<FJsonValue>& AssetValue : *Assets) {
        if (!AssetValue.IsValid() || AssetValue->Type != EJson::Object) {
            continue;
        }
        const TSharedPtr<FJsonObject> AssetObject = AssetValue->AsObject();
        if (!AssetObject.IsValid()) {
            continue;
        }
        FString CategoryFolder;
        FString AssetFolderName;
        FString AssetName;
        AssetObject->TryGetStringField(TEXT("categoryFolder"), CategoryFolder);
        AssetObject->TryGetStringField(TEXT("assetFolderName"), AssetFolderName);
        AssetObject->TryGetStringField(TEXT("name"), AssetName);
        const FString SafeCategoryFolder = MakeSafeFolderToken(CategoryFolder.IsEmpty() ? TEXT("Imported") : CategoryFolder);
        const FString SafeAssetFolderName = MakeSafeFolderToken(AssetFolderName.IsEmpty() ? AssetName : AssetFolderName);
        const FString DiskFolderPath = FPaths::ConvertRelativePathToFull(
            FPaths::Combine(FPaths::ProjectContentDir(), TEXT("AssetHive"), SafeCategoryFolder, SafeAssetFolderName)
        );
        if (IFileManager::Get().DirectoryExists(*DiskFolderPath)) {
            ExistingFolders.Add(DiskFolderPath);
        }
    }
    return ExistingFolders;
}

class FAssetHiveImportProgressOutputDevice final : public FOutputDevice
{
public:
    explicit FAssetHiveImportProgressOutputDevice(TFunction<void(float, const FString&)> InOnProgress)
        : OnProgress(MoveTemp(InOnProgress))
    {
    }

    virtual void Serialize(const TCHAR* V, ELogVerbosity::Type Verbosity, const class FName& Category) override
    {
        const FString Line = FString(V);
        const FString Marker = TEXT("[AssetHiveProgress]");
        const int32 MarkerIndex = Line.Find(Marker, ESearchCase::CaseSensitive);
        if (MarkerIndex == INDEX_NONE) {
            return;
        }
        FString Payload = Line.Mid(MarkerIndex + Marker.Len());
        Payload.TrimStartAndEndInline();
        FString PercentToken;
        FString Message;
        if (!Payload.Split(TEXT("|"), &PercentToken, &Message)) {
            return;
        }
        const float Percent = FMath::Clamp(static_cast<float>(FCString::Atoi(*PercentToken)), 0.0f, 100.0f);
        Message = Message.TrimStartAndEnd();
        if (OnProgress) {
            OnProgress(Percent, Message);
        }
    }

private:
    TFunction<void(float, const FString&)> OnProgress;
};

void FAssetHiveModule::StartupModule()
{
    LifetimeToken = MakeShared<TAtomic<bool>>(true);
    StartupTimestampMs = FDateTime::UtcNow().ToUnixTimestamp() * 1000;
    UpdateConnectionState();
    TickHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateRaw(this, &FAssetHiveModule::TickConnection), 2.0f);

    TCPServer = MakeUnique<FAssetHiveTCPServer>();
    const TWeakPtr<TAtomic<bool>> WeakLifetime = LifetimeToken;
    TCPServer->OnMessageReceived = [this, WeakLifetime](const FString& Message)
    {
        const TSharedPtr<TAtomic<bool>> Lifetime = WeakLifetime.Pin();
        if (!Lifetime.IsValid() || !Lifetime->Load())
        {
            return;
        }
        OnTCPMessageReceived(Message);
    };
    if (TCPServer->Init())
    {
        TCPServer->Start();
    }

    AssetHiveEditorToolbar::Register();
}

void FAssetHiveModule::ShutdownModule()
{
    AssetHiveEditorToolbar::Unregister();

    if (LifetimeToken.IsValid())
    {
        LifetimeToken->Store(false);
    }
    if (TickHandle.IsValid()) {
        FTSTicker::GetCoreTicker().RemoveTicker(TickHandle);
        TickHandle.Reset();
    }

    if (ImportProgressHandle.IsValid())
    {
        FSlateNotificationManager::Get().CancelProgressNotification(*ImportProgressHandle);
        ImportProgressHandle.Reset();
        LastImportPercent = 0;
    }

    if (TCPServer.IsValid())
    {
        TCPServer->OnMessageReceived = {};
        TCPServer->Shutdown();
        TCPServer.Reset();
    }

    LifetimeToken.Reset();
}

bool FAssetHiveModule::TickConnection(float DeltaTime)
{
    UpdateConnectionState();
    WriteEditorBridgeState();
    ConsumeImportRequest();
    ConsumeImportSignal();
    return true;
}

void FAssetHiveModule::UpdateConnectionState()
{
    const FString HeartbeatPath = GetBridgeHeartbeatPath();
    FString HeartbeatContent;
    if (FFileHelper::LoadFileToString(HeartbeatContent, *HeartbeatPath)) {
        TSharedPtr<FJsonObject> HeartbeatJson;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(HeartbeatContent);
        if (FJsonSerializer::Deserialize(Reader, HeartbeatJson) && HeartbeatJson.IsValid()) {
            double TimestampMs = 0.0;
            if (HeartbeatJson->TryGetNumberField(TEXT("timestamp"), TimestampMs)) {
                const int64 UtcNowMs = FDateTime::UtcNow().ToUnixTimestamp() * 1000;
                if (UtcNowMs - static_cast<int64>(TimestampMs) <= 12000) {
                    bConnectedToAssetHive = true;
                    return;
                }
            }
        }
    }
    bConnectedToAssetHive = false;
}

void FAssetHiveModule::ConsumeImportSignal()
{
    const FString SignalPath = GetImportSignalPath();
    FString SignalContent;
    if (!FFileHelper::LoadFileToString(SignalContent, *SignalPath)) {
        return;
    }
    TSharedPtr<FJsonObject> SignalJson;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(SignalContent);
    if (!FJsonSerializer::Deserialize(Reader, SignalJson) || !SignalJson.IsValid()) {
        return;
    }
    double TimestampMs = 0.0;
    if (!SignalJson->TryGetNumberField(TEXT("timestamp"), TimestampMs)) {
        return;
    }
    const int64 Timestamp = static_cast<int64>(TimestampMs);
    if (Timestamp <= LastImportSignalTimestamp) {
        return;
    }
    FString FolderPath;
    if (!SignalJson->TryGetStringField(TEXT("folder"), FolderPath) || FolderPath.IsEmpty()) {
        return;
    }
    LastImportSignalTimestamp = Timestamp;
    if (IContentBrowserSingleton* Browser = &FModuleManager::LoadModuleChecked<FContentBrowserModule>(TEXT("ContentBrowser")).Get()) {
        TArray<FString> Folders;
        Folders.Add(FolderPath);
        Browser->SyncBrowserToFolders(Folders);
    }
}

void FAssetHiveModule::WriteEditorBridgeState()
{
    const FString BridgeDir = FPaths::Combine(FPlatformProcess::UserDir(), TEXT("AssetHive"));
    IFileManager::Get().MakeDirectory(*BridgeDir, true);
    const FString ProjectPath = FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath());
    TSharedPtr<FJsonObject> Root = MakeShared<FJsonObject>();
    Root->SetStringField(TEXT("projectPath"), ProjectPath);
    Root->SetStringField(TEXT("pid"), FString::FromInt(FPlatformProcess::GetCurrentProcessId()));
    Root->SetNumberField(TEXT("timestamp"), static_cast<double>(FDateTime::UtcNow().ToUnixTimestamp()) * 1000.0);
    FString Serialized;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Serialized);
    if (FJsonSerializer::Serialize(Root.ToSharedRef(), Writer)) {
        FFileHelper::SaveStringToFile(Serialized, *GetEditorBridgeStatePath());
    }
}

void FAssetHiveModule::StartImportNotification()
{
    if (IsRunningCommandlet()) {
        return;
    }
    if (ImportProgressHandle.IsValid()) {
        FSlateNotificationManager::Get().CancelProgressNotification(*ImportProgressHandle);
    }
    LastImportPercent = 0;
    ImportProgressHandle = MakeShared<FProgressNotificationHandle>(FSlateNotificationManager::Get().StartProgressNotification(
        FText::FromString(TEXT("AssetHive 导入中")),
        100
    ));
    FSlateNotificationManager::Get().UpdateProgressNotification(
        *ImportProgressHandle,
        0,
        0,
        FText::FromString(TEXT("准备导入..."))
    );
}

void FAssetHiveModule::UpdateImportNotification(float Percent, const FString& Message)
{
    if (!ImportProgressHandle.IsValid()) {
        return;
    }
    const int32 PercentInt = FMath::Clamp(FMath::RoundToInt(Percent), 0, 100);
    const int32 ProgressValue = FMath::Max(LastImportPercent, PercentInt);
    LastImportPercent = ProgressValue;
    const FString DisplayMessage = Message.IsEmpty() ? TEXT("导入中...") : FString::Printf(TEXT("%s (%d%%)"), *Message, ProgressValue);
    FSlateNotificationManager::Get().UpdateProgressNotification(
        *ImportProgressHandle,
        ProgressValue,
        0,
        FText::FromString(DisplayMessage)
    );
}

void FAssetHiveModule::FinishImportNotification(bool bSuccess, const FString& Message)
{
    if (!ImportProgressHandle.IsValid()) {
        return;
    }
    if (bSuccess) {
        FSlateNotificationManager::Get().UpdateProgressNotification(
            *ImportProgressHandle,
            100,
            0,
            FText::FromString(Message.IsEmpty() ? TEXT("导入完成") : Message)
        );
    } else {
        FSlateNotificationManager::Get().UpdateProgressNotification(
            *ImportProgressHandle,
            FMath::Clamp(LastImportPercent, 0, 99),
            0,
            FText::FromString(Message.IsEmpty() ? TEXT("导入失败") : Message)
        );
    }
    FSlateNotificationManager::Get().CancelProgressNotification(*ImportProgressHandle);
    ImportProgressHandle.Reset();
    LastImportPercent = 0;
}

void FAssetHiveModule::ConsumeImportRequest()
{
    const FString RequestPath = GetImportRequestPath();
    FString RequestContent;
    if (!FFileHelper::LoadFileToString(RequestContent, *RequestPath)) {
        return;
    }
    TSharedPtr<FJsonObject> RequestJson;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RequestContent);
    if (!FJsonSerializer::Deserialize(Reader, RequestJson) || !RequestJson.IsValid()) {
        return;
    }
    double TimestampMs = 0.0;
    if (!RequestJson->TryGetNumberField(TEXT("timestamp"), TimestampMs)) {
        return;
    }
    const int64 Timestamp = static_cast<int64>(TimestampMs);
    if (Timestamp < StartupTimestampMs) {
        IFileManager::Get().Delete(*RequestPath, false, true, true);
        return;
    }
    if (Timestamp <= LastImportRequestTimestamp) {
        return;
    }
    const int64 UtcNowMs = FDateTime::UtcNow().ToUnixTimestamp() * 1000;
    if (UtcNowMs - Timestamp > 5 * 60 * 1000) {
        IFileManager::Get().Delete(*RequestPath, false, true, true);
        return;
    }
    FString RequestProjectPath;
    RequestJson->TryGetStringField(TEXT("projectPath"), RequestProjectPath);
    const auto NormalizeProjectPath = [](const FString& InPath) -> FString {
        FString Normalized = FPaths::ConvertRelativePathToFull(InPath);
        FPaths::NormalizeFilename(Normalized);
        return Normalized.ToLower();
    };
    const FString CurrentProjectPath = NormalizeProjectPath(FPaths::GetProjectFilePath());
    if (!RequestProjectPath.IsEmpty() && NormalizeProjectPath(RequestProjectPath) != CurrentProjectPath) {
        return;
    }
    FString RequestId;
    RequestJson->TryGetStringField(TEXT("requestId"), RequestId);
    FString JobFile;
    if (!RequestJson->TryGetStringField(TEXT("jobFile"), JobFile) || JobFile.IsEmpty()) {
        WriteImportResponse(RequestId, false, TEXT("导入任务缺少 Job 文件"));
        IFileManager::Get().Delete(*RequestPath, false, true, true);
        return;
    }
    if (!FPaths::FileExists(JobFile)) {
        WriteImportResponse(RequestId, false, TEXT("导入任务文件不存在"));
        IFileManager::Get().Delete(*RequestPath, false, true, true);
        return;
    }
    const TArray<FString> ExistingFolders = CollectExistingAssetFolders(JobFile);
    if (ExistingFolders.Num() > 0) {
        UE_LOG(
            LogTemp,
            Warning,
            TEXT("AssetHive import found %d existing folder(s). Continue import without blocking prompt. First folder: %s"),
            ExistingFolders.Num(),
            *ExistingFolders[0]
        );
    }
    LastImportRequestTimestamp = Timestamp;
    IFileManager::Get().Delete(*RequestPath, false, true, true);
    UAssetHiveImportCommandlet* Commandlet = NewObject<UAssetHiveImportCommandlet>(GetTransientPackage());
    int32 ExitCode = 1;
    FString Message = TEXT("导入失败");
    StartImportNotification();
    FAssetHiveImportProgressOutputDevice ProgressOutputDevice(
        [this, WeakLifetime = TWeakPtr<TAtomic<bool>>(LifetimeToken)](float Percent, const FString& ProgressMessage)
        {
            AsyncTask(ENamedThreads::GameThread, [this, WeakLifetime, Percent, ProgressMessage]()
            {
                const TSharedPtr<TAtomic<bool>> Lifetime = WeakLifetime.Pin();
                if (!Lifetime.IsValid() || !Lifetime->Load())
                {
                    return;
                }
                UpdateImportNotification(Percent, ProgressMessage);
            });
        }
    );
    if (GLog) {
        GLog->AddOutputDevice(&ProgressOutputDevice);
    }
    if (Commandlet) {
        const FString Params = FString::Printf(TEXT("Job=\"%s\""), *JobFile);
        ExitCode = Commandlet->Main(Params);
        Message = ExitCode == 0 ? TEXT("导入完成") : FString::Printf(TEXT("导入失败，退出码 %d"), ExitCode);
    }
    if (GLog) {
        GLog->RemoveOutputDevice(&ProgressOutputDevice);
    }
    FinishImportNotification(ExitCode == 0, Message);
    WriteImportResponse(RequestId, ExitCode == 0, Message);
}

void FAssetHiveModule::OnTCPMessageReceived(const FString& Message)
{
    TSharedPtr<FJsonObject> Json;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Message);
    if (!FJsonSerializer::Deserialize(Reader, Json) || !Json.IsValid())
    {
        UE_LOG(LogTemp, Warning, TEXT("AssetHive TCP: Failed to parse message"));
        return;
    }

    FString MessageType;
    if (!Json->TryGetStringField(TEXT("type"), MessageType))
    {
        UE_LOG(LogTemp, Warning, TEXT("AssetHive TCP: Message missing 'type' field"));
        return;
    }

    if (MessageType == TEXT("import_request"))
    {
        FString JobFile;
        FString RequestId;
        FString RequestProjectPath;
        Json->TryGetStringField(TEXT("jobFile"), JobFile);
        Json->TryGetStringField(TEXT("requestId"), RequestId);
        Json->TryGetStringField(TEXT("projectPath"), RequestProjectPath);
        
        if (!RequestProjectPath.IsEmpty())
        {
            FString Normalized = FPaths::ConvertRelativePathToFull(RequestProjectPath);
            FPaths::NormalizeFilename(Normalized);
            const FString Current = FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath());
            FString NormalizedCurrent = Current;
            FPaths::NormalizeFilename(NormalizedCurrent);
            if (Normalized.ToLower() != NormalizedCurrent.ToLower())
            {
                if (TCPServer.IsValid())
                {
                    TSharedPtr<FJsonObject> Response = MakeShared<FJsonObject>();
                    Response->SetStringField(TEXT("type"), TEXT("error"));
                    Response->SetStringField(TEXT("requestId"), RequestId);
                    Response->SetStringField(TEXT("message"), TEXT("Project path mismatch"));
                    FString Serialized;
                    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Serialized);
                    if (FJsonSerializer::Serialize(Response.ToSharedRef(), Writer))
                    {
                        TCPServer->SendMessage(Serialized);
                    }
                }
                return;
            }
        }

        if (!JobFile.IsEmpty() && !RequestId.IsEmpty())
        {
            HandleTCPImportRequest(JobFile, RequestId);
        }
        else
        {
            UE_LOG(LogTemp, Warning, TEXT("AssetHive TCP: Import request missing jobFile or requestId"));
        }
    }
    else if (MessageType == TEXT("import"))
    {
        FString JobFile;
        FString RequestId;
        FString RequestProjectPath;
        Json->TryGetStringField(TEXT("jobFile"), JobFile);
        Json->TryGetStringField(TEXT("requestId"), RequestId);
        Json->TryGetStringField(TEXT("projectPath"), RequestProjectPath);
        
        if (!RequestProjectPath.IsEmpty())
        {
            FString Normalized = FPaths::ConvertRelativePathToFull(RequestProjectPath);
            FPaths::NormalizeFilename(Normalized);
            const FString Current = FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath());
            FString NormalizedCurrent = Current;
            FPaths::NormalizeFilename(NormalizedCurrent);
            if (Normalized.ToLower() != NormalizedCurrent.ToLower())
            {
                if (TCPServer.IsValid())
                {
                    TSharedPtr<FJsonObject> Response = MakeShared<FJsonObject>();
                    Response->SetStringField(TEXT("type"), TEXT("error"));
                    Response->SetStringField(TEXT("requestId"), RequestId);
                    Response->SetStringField(TEXT("message"), TEXT("Project path mismatch"));
                    FString Serialized;
                    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Serialized);
                    if (FJsonSerializer::Serialize(Response.ToSharedRef(), Writer))
                    {
                        TCPServer->SendMessage(Serialized);
                    }
                }
                return;
            }
        }

        if (!JobFile.IsEmpty() && !RequestId.IsEmpty())
        {
            HandleTCPImportRequest(JobFile, RequestId);
        }
        else
        {
            UE_LOG(LogTemp, Warning, TEXT("AssetHive TCP: Import request missing jobFile or requestId"));
        }
    }
    else
    {
        UE_LOG(LogTemp, Log, TEXT("AssetHive TCP: Received unknown message type: %s"), *MessageType);
    }
}

void FAssetHiveModule::HandleTCPImportRequest(const FString& JobFile, const FString& RequestId)
{
    if (!FPaths::FileExists(JobFile))
    {
        if (TCPServer.IsValid())
        {
            TSharedPtr<FJsonObject> Response = MakeShared<FJsonObject>();
            Response->SetStringField(TEXT("type"), TEXT("error"));
            Response->SetStringField(TEXT("requestId"), RequestId);
            Response->SetStringField(TEXT("message"), TEXT("Job file not found"));
            
            FString Serialized;
            const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Serialized);
            if (FJsonSerializer::Serialize(Response.ToSharedRef(), Writer))
            {
                TCPServer->SendMessage(Serialized);
            }
        }
        return;
    }

    UE_LOG(LogTemp, Log, TEXT("AssetHive TCP: Starting import from TCP request - Job: %s"), *JobFile);

    AsyncTask(ENamedThreads::GameThread, [this, JobFile, RequestId, WeakLifetime = TWeakPtr<TAtomic<bool>>(LifetimeToken)]()
    {
        const TSharedPtr<TAtomic<bool>> Lifetime = WeakLifetime.Pin();
        if (!Lifetime.IsValid() || !Lifetime->Load())
        {
            return;
        }
        UAssetHiveImportCommandlet* Commandlet = NewObject<UAssetHiveImportCommandlet>(GetTransientPackage());
        int32 ExitCode = 1;
        FString Message = TEXT("Import failed");

        StartImportNotification();
        if (TCPServer.IsValid())
        {
            TSharedPtr<FJsonObject> Response = MakeShared<FJsonObject>();
            Response->SetStringField(TEXT("type"), TEXT("progress"));
            Response->SetStringField(TEXT("requestId"), RequestId);
            Response->SetNumberField(TEXT("percent"), 5);
            Response->SetStringField(TEXT("stage"), TEXT("Unreal 正在导入..."));
            FString Serialized;
            const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Serialized);
            if (FJsonSerializer::Serialize(Response.ToSharedRef(), Writer))
            {
                TCPServer->SendMessage(Serialized);
            }
        }
        FAssetHiveImportProgressOutputDevice ProgressOutputDevice(
            [this, RequestId, WeakLifetime](float Percent, const FString& ProgressMessage)
            {
                AsyncTask(ENamedThreads::GameThread, [this, WeakLifetime, Percent, ProgressMessage]()
                {
                    const TSharedPtr<TAtomic<bool>> LifetimeInner = WeakLifetime.Pin();
                    if (!LifetimeInner.IsValid() || !LifetimeInner->Load())
                    {
                        return;
                    }
                    UpdateImportNotification(Percent, ProgressMessage);
                });
                const TSharedPtr<TAtomic<bool>> LifetimeInner = WeakLifetime.Pin();
                if (LifetimeInner.IsValid() && LifetimeInner->Load() && TCPServer.IsValid())
                {
                    TSharedPtr<FJsonObject> Response = MakeShared<FJsonObject>();
                    Response->SetStringField(TEXT("type"), TEXT("progress"));
                    Response->SetStringField(TEXT("requestId"), RequestId);
                    Response->SetNumberField(TEXT("percent"), FMath::Clamp(Percent, 0.0f, 100.0f));
                    Response->SetStringField(TEXT("stage"), ProgressMessage);
                    FString Serialized;
                    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Serialized);
                    if (FJsonSerializer::Serialize(Response.ToSharedRef(), Writer))
                    {
                        TCPServer->SendMessage(Serialized);
                    }
                }
            }
        );
        if (GLog)
        {
            GLog->AddOutputDevice(&ProgressOutputDevice);
        }

        if (Commandlet)
        {
            const FString Params = FString::Printf(TEXT("Job=\"%s\""), *JobFile);
            ExitCode = Commandlet->Main(Params);
            Message = ExitCode == 0 ? TEXT("Import completed") : FString::Printf(TEXT("Import failed, exit code %d"), ExitCode);
        }

        if (GLog)
        {
            GLog->RemoveOutputDevice(&ProgressOutputDevice);
        }

        FinishImportNotification(ExitCode == 0, Message);

        if (TCPServer.IsValid())
        {
            TSharedPtr<FJsonObject> Response = MakeShared<FJsonObject>();
            Response->SetStringField(TEXT("type"), ExitCode == 0 ? TEXT("complete") : TEXT("error"));
            Response->SetStringField(TEXT("requestId"), RequestId);
            Response->SetStringField(TEXT("message"), Message);

            FString Serialized;
            const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Serialized);
            if (FJsonSerializer::Serialize(Response.ToSharedRef(), Writer))
            {
                TCPServer->SendMessage(Serialized);
            }
        }
    });
}
