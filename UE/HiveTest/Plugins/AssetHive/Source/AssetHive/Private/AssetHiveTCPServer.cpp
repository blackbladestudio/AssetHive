#include "AssetHiveTCPServer.h"
#include "Sockets.h"
#include "SocketSubsystem.h"
#include "Containers/StringConv.h"
#include "Misc/OutputDevice.h"
#include "Interfaces/IPv4/IPv4Address.h"

FAssetHiveTCPServer::FAssetHiveTCPServer()
    : ListenerSocket(nullptr)
    , ClientSocket(nullptr)
    , LocalHostIP("127.0.0.1")
    , PortNum(13430)
    , bRunThread(false)
    , Thread(nullptr)
{
}

FAssetHiveTCPServer::~FAssetHiveTCPServer()
{
    Shutdown();
}

bool FAssetHiveTCPServer::Init()
{
    ISocketSubsystem* SocketSub = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM);
    if (!SocketSub)
    {
        UE_LOG(LogTemp, Error, TEXT("AssetHive TCP Server: socket subsystem unavailable"));
        return false;
    }

    TSharedPtr<FInternetAddr> Addr = SocketSub->CreateInternetAddr();

    FIPv4Address ParsedAddr;
    if (!FIPv4Address::Parse(LocalHostIP, ParsedAddr))
    {
        UE_LOG(LogTemp, Error, TEXT("Invalid IP address: %s"), *LocalHostIP);
        return false;
    }

    Addr->SetIp(ParsedAddr.Value);
    Addr->SetPort(PortNum);

    ListenerSocket = SocketSub->CreateSocket(NAME_Stream, TEXT("AssetHiveListener"), false);
    if (ListenerSocket)
    {
        ListenerSocket->SetReuseAddr(true);
        ListenerSocket->SetNonBlocking(true);

        if (!ListenerSocket->Bind(*Addr) || !ListenerSocket->Listen(8))
        {
            SocketSub->DestroySocket(ListenerSocket);
            ListenerSocket = nullptr;
        }
    }

    if (!ListenerSocket)
    {
        UE_LOG(LogTemp, Error, TEXT("AssetHive TCP Server failed to create listener socket"));
        return false;
    }

    UE_LOG(LogTemp, Log, TEXT("AssetHive TCP Server started on %s:%d"), *LocalHostIP, PortNum);
    return true;
}

bool FAssetHiveTCPServer::Start()
{
    if (Thread || !ListenerSocket)
    {
        return Thread != nullptr;
    }
    bRunThread = true;
    Thread = FRunnableThread::Create(this, TEXT("AssetHiveTCPServer"));
    if (!Thread)
    {
        bRunThread = false;
        UE_LOG(LogTemp, Error, TEXT("AssetHive TCP Server failed to create thread"));
        return false;
    }
    return true;
}

uint32 FAssetHiveTCPServer::Run()
{
    while (bRunThread)
    {
        bool bPending;
        if (ListenerSocket && ListenerSocket->HasPendingConnection(bPending) && bPending)
        {
            FSocket* AcceptedSocket = ListenerSocket->Accept(TEXT("AssetHiveClient"));
            if (AcceptedSocket)
            {
                {
                    FScopeLock Lock(&SendCriticalSection);
                    ClientSocket = AcceptedSocket;
                }
                UE_LOG(LogTemp, Log, TEXT("AssetHive TCP Client connected"));

                bool bClientAlive = true;
                while (bRunThread && bClientAlive)
                {
                    uint32 DataSize = 0;
                    if (AcceptedSocket->HasPendingData(DataSize) && DataSize > 0)
                    {
                        FString Message;
                        if (!RecvMessage(AcceptedSocket, DataSize, Message))
                        {
                            // Recv failed or peer closed — bail out
                            bClientAlive = false;
                            break;
                        }
                        if (!Message.IsEmpty())
                        {
                            ProcessMessage(Message);
                        }
                    }
                    else
                    {
                        // Detect half-closed connection via connection state
                        const ESocketConnectionState State = AcceptedSocket->GetConnectionState();
                        if (State != SCS_Connected)
                        {
                            bClientAlive = false;
                            break;
                        }
                    }
                    FPlatformProcess::Sleep(0.01f);
                }

                {
                    FScopeLock Lock(&SendCriticalSection);
                    if (ClientSocket)
                    {
                        ClientSocket->Close();
                        if (ISocketSubsystem* SocketSub = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM))
                        {
                            SocketSub->DestroySocket(ClientSocket);
                        }
                        ClientSocket = nullptr;
                    }
                }
                ReceiveBuffer.Empty();
                UE_LOG(LogTemp, Log, TEXT("AssetHive TCP Client disconnected"));
            }
        }
        FPlatformProcess::Sleep(0.05f);
    }

    return 0;
}

void FAssetHiveTCPServer::Stop()
{
    // FRunnable::Stop is only a signal — teardown happens in Shutdown()
    bRunThread = false;
}

void FAssetHiveTCPServer::Shutdown()
{
    bRunThread = false;

    // Close sockets first so any blocking/polling calls return quickly.
    {
        FScopeLock Lock(&SendCriticalSection);
        if (ListenerSocket)
        {
            ListenerSocket->Close();
        }
        if (ClientSocket)
        {
            ClientSocket->Close();
        }
    }

    // Move Thread pointer aside before delete so that a re-entrant Stop()
    // triggered by Kill() during destruction does not try to delete again.
    if (FRunnableThread* LocalThread = Thread)
    {
        Thread = nullptr;
        if (LocalThread != FRunnableThread::GetRunnableThread())
        {
            LocalThread->WaitForCompletion();
            delete LocalThread;
        }
    }

    ISocketSubsystem* SocketSub = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM);
    FScopeLock Lock(&SendCriticalSection);
    if (ClientSocket)
    {
        if (SocketSub)
        {
            SocketSub->DestroySocket(ClientSocket);
        }
        ClientSocket = nullptr;
    }
    if (ListenerSocket)
    {
        if (SocketSub)
        {
            SocketSub->DestroySocket(ListenerSocket);
        }
        ListenerSocket = nullptr;
    }
}

void FAssetHiveTCPServer::Exit()
{
}

bool FAssetHiveTCPServer::RecvMessage(FSocket* Socket, uint32 DataSize, FString& Message)
{
    FScopeLock Lock(&ReceiveCriticalSection);

    TArray<uint8> ReceivedData;
    ReceivedData.SetNum(DataSize);

    int32 BytesRead = 0;
    if (!Socket->Recv(ReceivedData.GetData(), ReceivedData.Num(), BytesRead))
    {
        // Recv failed — treat as disconnect
        return false;
    }
    if (BytesRead == 0)
    {
        // Peer closed the connection cleanly
        return false;
    }

    const FUTF8ToTCHAR Converter(reinterpret_cast<const ANSICHAR*>(ReceivedData.GetData()), BytesRead);
    ReceiveBuffer += FString(Converter.Length(), Converter.Get());

    const int32 LastNewlineIndex = ReceiveBuffer.Find(TEXT("\n"), ESearchCase::CaseSensitive, ESearchDir::FromEnd);
    if (LastNewlineIndex != INDEX_NONE)
    {
        Message = ReceiveBuffer.Left(LastNewlineIndex + 1);
        ReceiveBuffer = ReceiveBuffer.Mid(LastNewlineIndex + 1);
    }
    // No complete line yet — connection still alive, just keep buffering
    return true;
}

void FAssetHiveTCPServer::ProcessMessage(const FString& Message)
{
    if (OnMessageReceived)
    {
        TArray<FString> Lines;
        Message.ParseIntoArrayLines(Lines, false);
        for (const FString& Line : Lines)
        {
            const FString Trimmed = Line.TrimStartAndEnd();
            if (Trimmed.IsEmpty())
            {
                continue;
            }
            TFunction<void(const FString&)> Callback = OnMessageReceived;
            AsyncTask(ENamedThreads::GameThread, [Callback, Trimmed]()
            {
                if (Callback)
                {
                    Callback(Trimmed);
                }
            });
        }
    }
}

void FAssetHiveTCPServer::SendMessage(const FString& Message)
{
    FScopeLock Lock(&SendCriticalSection);

    if (ClientSocket)
    {
        const FString Payload = Message + TEXT("\n");
        FTCHARToUTF8 Converter(*Payload);
        int32 BytesSent = 0;
        ClientSocket->Send((uint8*)Converter.Get(), Converter.Length(), BytesSent);
    }
}
