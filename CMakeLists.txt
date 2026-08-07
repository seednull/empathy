cmake_minimum_required(VERSION 3.10)
project(empathy VERSION 1.0.0)

include(CTest)

# ==================================================================================================
# Global includes
# ==================================================================================================
list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

# ==================================================================================================
# Global options
# ==================================================================================================
option(EMPATHY_BUILD_SAMPLES "Build samples" TRUE)

# ==================================================================================================
# Global Variables
# ==================================================================================================
enable_language(C)

set(EMPATHY_DIR_API ${CMAKE_CURRENT_SOURCE_DIR}/include)
set(EMPATHY_DIR_SRC ${CMAKE_CURRENT_SOURCE_DIR}/src)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if (WIN32)
	set(EMPATHY_PLATFORM windows)
	set(EMPATHY_ABI x64)
endif()

if (APPLE)
	set(EMPATHY_PLATFORM macos)
	set(EMPATHY_ABI x64) # FIXME: Is it always x64?
	enable_language(OBJC)
	enable_language(OBJCXX)
endif()

if (EMSCRIPTEN)
	set(EMPATHY_PLATFORM emscripten)
	set(EMPATHY_ABI wasm)
	set(CMAKE_EXECUTABLE_SUFFIX ".html")
endif()

message("Platform: ${EMPATHY_PLATFORM}")
message("ABI: ${EMPATHY_ABI}")

# ==================================================================================================
# General compile flags
# ==================================================================================================
if (WIN32)
	set(CMAKE_C_FLAGS "/W4 /external:W3 /wd4996 /D_CRT_SECURE_NO_WARNINGS")
	set(CMAKE_CXX_FLAGS "/W4 /external:W3 /wd4996 /D_CRT_SECURE_NO_WARNINGS /EHsc /GR-")
endif()

if (EMSCRIPTEN)
	set(CMAKE_C_FLAGS_DEBUG "-g")
	set(CMAKE_CXX_FLAGS_DEBUG "-g")
endif()

# ==================================================================================================
# General includes
# ==================================================================================================

# ==================================================================================================
# General libraries
# ==================================================================================================

# ==================================================================================================
# Sub-projects
# ==================================================================================================
add_subdirectory(src)

if (EMPATHY_BUILD_SAMPLES)
	add_subdirectory(samples/01_machine)
	add_subdirectory(samples/02_narrative)
endif()

if (BUILD_TESTING)
	add_subdirectory(tests/bytecode)
endif()
