# Methods the web page calls through the AndroidBridge JavaScript interface.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
