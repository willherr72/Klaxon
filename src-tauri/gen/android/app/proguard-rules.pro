# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ── Klaxon ──────────────────────────────────────────────────────────
# Background-sync JNI bridge. The native symbol
# Java_com_klaxon_app_BackgroundSyncWorker_nativeSyncOnce is resolved by
# its exact package + class + method name, so R8/ProGuard must not rename
# or strip them. WorkManager also instantiates this worker reflectively by
# class name. The default android rules keep classes with native methods,
# but we make it explicit so a release build can never silently break the
# background sync.
-keep class com.klaxon.app.BackgroundSyncWorker { *; }