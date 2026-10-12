package com.example.zcode_mobile.remote

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.example.zcode_mobile.MainActivity
import com.example.zcode_mobile.R

class RemoteControlKeepAliveService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val remoteUrl = intent?.getStringExtra(EXTRA_REMOTE_URL).orEmpty()
        ensureNotificationChannel()

        // Bugfix: after the app goes to the background, the WebView/JS/WebSocket
        // are easily suspended or reclaimed by the system. A foreground service
        // cannot guarantee the WebView socket never drops, but it gives the
        // remote-control session a user-visible keep-alive boundary and lowers
        // the chance of the process being killed; actual state recovery is still
        // handled by the web-side replayable snapshot protocol.
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_remote_control)
            .setContentTitle(getString(R.string.remote_keep_alive_title))
            .setContentText(getString(R.string.remote_keep_alive_text))
            .setContentIntent(createContentIntent(remoteUrl))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) {
            return
        }

        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.remote_keep_alive_channel),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.remote_keep_alive_channel_description)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun createContentIntent(remoteUrl: String): PendingIntent {
        val intent = Intent(this, MainActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .putExtra(EXTRA_REMOTE_URL, remoteUrl)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    companion object {
        private const val CHANNEL_ID = "zcode_remote_control"
        private const val NOTIFICATION_ID = 1001
        const val EXTRA_REMOTE_URL = "com.example.zcode_mobile.remote.REMOTE_URL"

        fun start(context: Context, remoteUrl: String) {
            val intent = Intent(context, RemoteControlKeepAliveService::class.java)
                .putExtra(EXTRA_REMOTE_URL, remoteUrl)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RemoteControlKeepAliveService::class.java))
        }
    }
}
