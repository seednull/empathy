#pragma once

#include <stdint.h> // TODO: get rid of this dependency later

// Version
#define EMPATHY_VERSION_MAJOR 1
#define EMPATHY_VERSION_MINOR 0
#define EMPATHY_VERSION_PATCH 0
#define EMPATHY_VERSION "1.0.0-dev"

// Platform specific defines
#if defined(_WIN32)
	#define EMPATHY_EXPORT		__declspec(dllexport)
	#define EMPATHY_IMPORT		__declspec(dllimport)
	#define EMPATHY_INLINE		__forceinline
	#define EMPATHY_RESTRICT	__restrict
#else
	#define EMPATHY_EXPORT		__attribute__((visibility("default")))
	#define EMPATHY_IMPORT
	#define EMPATHY_INLINE		__inline__
	#define EMPATHY_RESTRICT	__restrict
#endif

#if defined(EMPATHY_SHARED_LIBRARY)
	#define EMPATHY_APIENTRY extern EMPATHY_EXPORT
#else
	#define EMPATHY_APIENTRY extern EMPATHY_IMPORT
#endif

#if !defined(EMPATHY_NULL_HANDLE)
	#define EMPATHY_NULL_HANDLE 0
#endif

#define EMPATHY_DEFINE_HANDLE(TYPE) typedef uint64_t TYPE

#ifdef __cplusplus
extern "C" {
#endif

// Opaque handles
EMPATHY_DEFINE_HANDLE(Empathy_Instance);

// Enums
typedef enum Empathy_Result_t
{
	EMPATHY_SUCCESS = 0,
	EMPATHY_NOT_IMPLEMENTED,
	EMPATHY_INVALID_INSTANCE,
	EMPATHY_INVALID_OUTPUT_ARGUMENT,

	EMPATHY_RESULT_ENUM_MAX,
	EMPATHY_RESULT_ENUM_FORCE32 = 0x7FFFFFFF,
} Empathy_Result;

// Structs
typedef struct Empathy_InstanceDesc_t
{
	uint32_t reserved;
	// TODO: allocator context
	// TOOD: flags?
} Empathy_InstanceDesc;

// Function pointers
typedef Empathy_Result (*PFN_empathyDestroyInstance)(Empathy_Instance instance);

typedef struct Empathy_InstanceTable_t
{
	PFN_empathyDestroyInstance destroyInstance;
} Empathy_InstanceTable;

// API
#if !defined(EMPATHY_NO_PROTOTYPES)
EMPATHY_APIENTRY Empathy_Result empathyCreateInstance(const Empathy_InstanceDesc *desc, Empathy_Instance* instance);
EMPATHY_APIENTRY Empathy_Result empathyGetInstanceTable(Empathy_Instance instance, Empathy_InstanceTable *instance_table);

EMPATHY_APIENTRY Empathy_Result empathyDestroyInstance(Empathy_Instance instance);
#endif

#ifdef __cplusplus
}
#endif
