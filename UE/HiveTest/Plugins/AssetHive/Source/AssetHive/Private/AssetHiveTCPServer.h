#pragma once

#include "CoreMinimal.h"
#include "HAL/Runnable.h"
#include "HAL/RunnableThread.h"
#include "Networking.h"
#include "Async/Async.h"

class FAssetHiveTCPServer : public FRunnable
{
public:
    FAssetHiveTCPServer();
    virtual ~FAssetHiveTCPServer();

    virtual bool Init() override;
    virtual uint32 Run() override;
    virtual void Stop() override;
    virtual void Exit() override;
    bool Start();
    void Shutdown();

    void SendMessage(const FString& Message);

    TFunction<void(const FString&)> OnMessageReceived;

private:
    bool RecvMessage(FSocket* Socket, uint32 DataSize, FString& Message);
    void ProcessMessage(const FString& Message);

    FSocket* ListenerSocket;
    FSocket* ClientSocket;
    FString LocalHostIP;
    int32 PortNum;
    TAtomic<bool> bRunThread;
    FRunnableThread* Thread;
    FCriticalSection SendCriticalSection;
    FCriticalSection ReceiveCriticalSection;
    FString ReceiveBuffer;
};
